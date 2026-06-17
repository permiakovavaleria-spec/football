/* =====================================================================
   ⚽ НАБИВАЛКА  —  HTML5 мобильная игра (вертикальная)
   Логика: набивай мяч (тап = удар), не урони, каждые 20 ударов —
   мини-игра с вратарём. 16-битный parallax-фон как на Сеге.
   Графика рисуется кодом, звуки — mp3 из assets/sounds/ (опционально).
   ===================================================================== */

(() => {
  'use strict';

  // ---- Внутреннее разрешение (низкое = чёткие ретро-пиксели при растяжении)
  const GW = 200;          // ширина игрового мира в "пикселях" (фиксирована)
  let   GH = 356;          // высота — подгоняется под экран в resize()
  let   FLOOR_Y = 330;     // линия земли (ниже неё мяч считается упавшим)

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  // ---------------------------------------------------------------
  //  Масштабирование под экран.
  //  Мир по ширине = GW (200), а высота GH подгоняется так, чтобы
  //  заполнить весь экран целиком (без чёрных полос). Пиксели квадратные.
  //  На широком экране (десктоп) — портретный бокс по центру.
  // ---------------------------------------------------------------
  let scale = 1;
  function resize() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const targetW = Math.min(vw, vh * 0.6);   // на десктопе — узкий портрет
    scale = targetW / GW;
    GH = Math.round(vh / scale);               // мир ровно по высоте экрана
    FLOOR_Y = GH - 26;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width  = Math.round(targetW * dpr);
    canvas.height = Math.round(vh * dpr);
    canvas.style.width  = targetW + 'px';
    canvas.style.height = vh + 'px';
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------------------------------------------------------------
  //  Звуки (грузятся лениво, без файла — просто молчат)
  // ---------------------------------------------------------------
  // Настройки звука (сохраняются между сессиями)
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const settings = {
    volume:  clamp01(parseFloat(localStorage.getItem('nabivalka_vol') ?? '0.7')),
    musicOn: localStorage.getItem('nabivalka_music') !== '0'
  };
  function saveSettings() {
    localStorage.setItem('nabivalka_vol', settings.volume);
    localStorage.setItem('nabivalka_music', settings.musicOn ? '1' : '0');
  }

  const Sound = {
    bank: {},
    load(name, file) {
      const a = new Audio('assets/sounds/' + file);
      a.preload = 'auto';
      this.bank[name] = a;
    },
    play(name, vol = 1) {
      const a = this.bank[name];
      if (!a) return;
      try {
        const node = a.cloneNode();   // клон — чтобы звуки накладывались
        node.volume = clamp01(vol * settings.volume);   // общая громкость
        node.play().catch(() => {});
      } catch (e) { /* нет файла — молчим */ }
    }
  };
  Sound.load('kick',    'kick.mp3');     // удар по мячу (набивание)
  Sound.load('goal',    'goal.mp3');     // гооол + стадион
  Sound.load('whistle', 'whistle.mp3');  // свист толпы (уронил мяч)
  Sound.load('life',    'life.mp3');     // +жизнь за 100 очков
  Sound.load('save',    'save.mp3');     // вратарь поймал (опционально)

  // Фоновая музыка — зацикленная, чуть тише звуков
  const Music = {
    el: new Audio('assets/sounds/music.mp3'),
    init() { this.el.loop = true; this.el.preload = 'auto'; this.apply(); },
    apply() { this.el.volume = settings.musicOn ? clamp01(settings.volume * 0.55) : 0; },
    start() {                                  // вызывать после жеста пользователя
      this.apply();
      if (settings.musicOn) this.el.play().catch(() => {});
    },
    toggle() {
      settings.musicOn = !settings.musicOn;
      this.apply();
      if (settings.musicOn) this.el.play().catch(() => {}); else this.el.pause();
      saveSettings();
    }
  };
  Music.init();

  // ---------------------------------------------------------------
  //  Состояние игры
  // ---------------------------------------------------------------
  const STATE = { START:'start', PLAY:'play', KEEPER:'keeper', OVER:'over' };
  let state = STATE.START;

  const game = {
    score: 0,
    lives: 3,
    juggles: 0,           // всего ударов
    nextKeeperAt: 20,     // следующий вызов вратаря
    nextLifeAt: 100,      // следующая бонусная жизнь
    worldX: 0,            // прокрутка мира (для parallax), растёт = идём влево
    best: +(localStorage.getItem('nabivalka_best') || 0)
  };

  // Мяч
  const ball = {
    x: 150, y: 160, r: 13,
    vy: 0, vx: 0,
    angle: 0, spin: 0
  };

  // Нога (анимация удара)
  let footKick = 0;       // 0..1, всплеск при ударе

  const GRAVITY = 900;    // px/сек²
  const KICK_VY = -430;   // скорость мяча после удара (вверх)

  // ---------------------------------------------------------------
  //  Вратарь (мини-игра)
  // ---------------------------------------------------------------
  const keeper = {
    phase: 'aim',         // aim -> ready -> shoot -> result
    aimX: 0.5,            // куда целимся по горизонтали (0..1 по воротам)
    aimY: 0.5,            // куда целимся по вертикали (0..1 по воротам)
    keeperX: 0.5,         // позиция вратаря по горизонтали (0..1)
    keeperY: 0.6,         // позиция вратаря по вертикали (0..1)
    diveTo: 0.5,          // куда прыгает по X
    diveY: 0.6,           // куда прыгает по Y
    t: 0,                 // таймер анимаций
    result: null,         // 'goal' | 'save'
    armWave: 0,
    shotFrom: {x:0,y:0}, shotTo: {x:0,y:0}
  };

  // Геометрия ворот на экране (в мировых координатах)
  const GOAL = { x: 40, y: 120, w: 120, h: 70 };

  // ---------------------------------------------------------------
  //  HUD / экраны (DOM)
  // ---------------------------------------------------------------
  const el = (id) => document.getElementById(id);
  const hud = el('hud'), banner = el('banner');
  const scoreEl = el('score'), comboEl = el('combo'),
        livesEl = el('lives'), nextEl = el('next-keeper');

  function updateHUD() {
    scoreEl.textContent = game.score;
    comboEl.textContent = 'УДАРЫ: ' + game.juggles;
    livesEl.textContent = '❤'.repeat(Math.max(0, game.lives)) || '—';
    const left = game.nextKeeperAt - game.juggles;
    nextEl.textContent = 'ВРАТАРЬ ЧЕРЕЗ ' + Math.max(0, left);
  }

  function showBanner(html, big = false) {
    banner.innerHTML = big ? '<span class="big">' + html + '</span>' : html;
    banner.classList.remove('hidden');
  }
  function hideBanner() { banner.classList.add('hidden'); }

  // ---------------------------------------------------------------
  //  Старт / рестарт / конец
  // ---------------------------------------------------------------
  function startGame() {
    game.score = 0; game.lives = 3; game.juggles = 0;
    game.nextKeeperAt = 20; game.nextLifeAt = 100; game.worldX = 0;
    ball.x = 150; ball.y = 150; ball.vy = 0; ball.vx = 0; ball.angle = 0; ball.spin = 6;
    footKick = 0;
    state = STATE.PLAY;
    paused = false;
    el('screen-start').classList.add('hidden');
    el('screen-over').classList.add('hidden');
    el('screen-settings').classList.add('hidden');
    hud.classList.remove('hidden');
    el('btn-settings').classList.remove('hidden');   // показать шестерёнку
    hideBanner();
    updateHUD();
    Music.start();                                    // музыка — после жеста (клик ИГРАТЬ)
  }

  function gameOver() {
    state = STATE.OVER;
    Sound.play('whistle');
    if (game.score > game.best) {
      game.best = game.score;
      localStorage.setItem('nabivalka_best', game.best);
    }
    el('final-score').textContent = game.score;
    el('best-score').textContent = game.best;
    el('screen-over').classList.remove('hidden');
    hud.classList.add('hidden');
    el('btn-settings').classList.add('hidden');
    hideBanner();
  }

  el('btn-start').addEventListener('click', (e) => { e.stopPropagation(); startGame(); });
  el('btn-restart').addEventListener('click', (e) => { e.stopPropagation(); startGame(); });

  // ---------------------------------------------------------------
  //  Пауза / настройки
  // ---------------------------------------------------------------
  let paused = false;

  function openSettings() {
    if (state !== STATE.PLAY && state !== STATE.KEEPER) return;
    paused = true;
    syncSettingsUI();
    el('screen-settings').classList.remove('hidden');
  }
  function closeSettings() {
    paused = false;
    last = 0;                                  // сброс, чтобы dt не скакнул
    el('screen-settings').classList.add('hidden');
  }

  function syncSettingsUI() {
    const filled = Math.round(settings.volume * 10);
    let cells = '';
    for (let i = 0; i < 10; i++) cells += '<span class="cell' + (i < filled ? ' on' : '') + '"></span>';
    el('vol-bar').innerHTML = cells;
    const mb = el('btn-music');
    mb.textContent = 'МУЗЫКА: ' + (settings.musicOn ? 'ВКЛ' : 'ВЫКЛ');
    mb.classList.toggle('off', !settings.musicOn);
  }

  function changeVolume(delta) {
    settings.volume = clamp01(Math.round((settings.volume + delta) * 10) / 10);
    Music.apply();
    saveSettings();
    syncSettingsUI();
    Sound.play('kick', 1);                     // щелчок — чтобы слышно громкость
  }

  el('btn-settings').addEventListener('click', (e) => { e.stopPropagation(); openSettings(); });
  el('btn-resume').addEventListener('click', (e) => { e.stopPropagation(); closeSettings(); });
  el('vol-down').addEventListener('click', (e) => { e.stopPropagation(); changeVolume(-0.1); });
  el('vol-up').addEventListener('click', (e) => { e.stopPropagation(); changeVolume(+0.1); });
  el('btn-music').addEventListener('click', (e) => { e.stopPropagation(); Music.toggle(); syncSettingsUI(); });

  // ---------------------------------------------------------------
  //  Ввод (тап / клик)
  // ---------------------------------------------------------------
  function worldPos(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (clientX - rect.left) / scale,
      y: (clientY - rect.top) / scale
    };
  }

  function onTap(wx, wy) {
    if (paused) return;                         // на паузе тапы по полю не работают
    if (state === STATE.PLAY) {
      tryKick();
    } else if (state === STATE.KEEPER) {
      keeperTap(wx, wy);
    }
  }

  canvas.addEventListener('pointerdown', (e) => {
    const p = worldPos(e.clientX, e.clientY);
    onTap(p.x, p.y);
  });

  // ---------------------------------------------------------------
  //  Механика набивания
  // ---------------------------------------------------------------
  function tryKick() {
    // бьём только если мяч в нижней зоне (у ноги) и летит вниз
    const inZone = ball.y + ball.r > FLOOR_Y - 95 && ball.y < FLOOR_Y;
    if (inZone && ball.vy > -50) {
      ball.vy = KICK_VY;
      ball.vx = (150 - ball.x) * 1.4 + (Math.sin(game.juggles * 1.3) * 30); // лёгкий разброс, тянем к ноге
      ball.spin = ball.vx * 0.05 + 7;
      footKick = 1;
      game.juggles++;
      addScore(1);
      Sound.play('kick', 0.9);

      if (game.juggles >= game.nextKeeperAt) {
        startKeeper();
      }
    }
  }

  function addScore(n) {
    game.score += n;
    if (game.score >= game.nextLifeAt) {
      game.lives++;
      game.nextLifeAt += 100;
      Sound.play('life');
      flashLife();
    }
    updateHUD();
  }

  let lifeFlash = 0;
  function flashLife() { lifeFlash = 1; showBanner('+1 ЖИЗНЬ ❤', true); setTimeout(hideBanner, 900); }

  function dropBall() {
    game.lives--;
    updateHUD();
    Sound.play('whistle');
    if (game.lives <= 0) {
      gameOver();
    } else {
      // новый мяч падает сверху
      ball.x = 150; ball.y = 40; ball.vy = 0; ball.vx = 0; ball.spin = 5;
      showBanner('УПС! ОСТАЛОСЬ ' + game.lives + ' ❤');
      setTimeout(hideBanner, 1100);
    }
  }

  // ---------------------------------------------------------------
  //  Вратарь — мини-игра
  // ---------------------------------------------------------------
  function startKeeper() {
    state = STATE.KEEPER;
    keeper.phase = 'aim';
    keeper.aimX = 0.5; keeper.aimY = 0.5;
    keeper.keeperX = 0.5; keeper.keeperY = 0.6;
    keeper.t = 0;
    keeper.result = null;
    keeper.armWave = 0;
    ball.x = 100; ball.y = FLOOR_Y - 30; ball.vy = 0; ball.vx = 0; ball.spin = 0;
    showBanner('ПЕНАЛЬТИ!<br>👆 ткни в угол ворот');
  }

  function keeperTap(wx, wy) {
    if (keeper.phase === 'aim') {
      // тап в любую точку ворот -> ставим прицел (X и Y)
      if (wy < GOAL.y + GOAL.h + 30) {
        keeper.aimX = Math.max(0.08, Math.min(0.92, (wx - GOAL.x) / GOAL.w));
        keeper.aimY = Math.max(0.12, Math.min(0.88, (wy - GOAL.y) / GOAL.h));
        keeper.phase = 'ready';
        showBanner('БЕЙ! 👟');
      }
    } else if (keeper.phase === 'ready') {
      // удар!
      keeper.phase = 'shoot';
      keeper.t = 0;
      keeper.shotFrom = { x: ball.x, y: ball.y };
      // мяч летит ТОЧНО в выбранную точку
      keeper.shotTo = {
        x: GOAL.x + keeper.aimX * GOAL.w,
        y: GOAL.y + keeper.aimY * GOAL.h
      };
      // СНАЧАЛА решаем исход 50/50, ПОТОМ ставим вратаря согласованно:
      keeper.result = Math.random() < 0.5 ? 'goal' : 'save';
      if (keeper.result === 'save') {
        keeper.diveTo = keeper.aimX;                 // прыгает ровно на мяч — ловит
        keeper.diveY = keeper.aimY;                  // и по высоте тянется к мячу
      } else {
        // ГОЛ: прыгает в ДРУГОЙ угол, явно мимо мяча
        keeper.diveTo = keeper.aimX < 0.5
          ? 0.72 + Math.random() * 0.16              // мяч слева -> вратарь вправо
          : 0.28 - Math.random() * 0.16;             // мяч справа -> вратарь влево
        keeper.diveY = 0.5;                          // ушёл не туда по высоте
      }
      hideBanner();
    }
  }

  function updateKeeper(dt) {
    keeper.armWave += dt * 6;
    if (keeper.phase === 'shoot') {
      keeper.t += dt;
      const T = 0.45;                     // длительность полёта мяча
      const k = Math.min(1, keeper.t / T);
      ball.x = keeper.shotFrom.x + (keeper.shotTo.x - keeper.shotFrom.x) * k;
      ball.y = keeper.shotFrom.y + (keeper.shotTo.y - keeper.shotFrom.y) * k - Math.sin(k * Math.PI) * 30;
      ball.spin = 16;
      // вратарь решительно прыгает (на сейв — на мяч, на гол — мимо)
      keeper.keeperX += (keeper.diveTo - keeper.keeperX) * Math.min(1, dt * 11);
      keeper.keeperY += (keeper.diveY  - keeper.keeperY) * Math.min(1, dt * 11);
      if (k >= 1) {
        keeper.phase = 'result';
        keeper.t = 0;
        if (keeper.result === 'goal') {
          addScore(50);
          Sound.play('goal');
          showBanner('ГОООЛ! +50', true);
        } else {
          Sound.play('save');
          showBanner('СЕЙВ! 🧤');
        }
      }
    } else if (keeper.phase === 'result') {
      keeper.t += dt;
      if (keeper.t > 1.4) {
        // назад к набиванию
        hideBanner();
        game.nextKeeperAt = game.juggles + 20;
        ball.x = 150; ball.y = 60; ball.vy = 0; ball.vx = 0; ball.spin = 5;
        state = STATE.PLAY;
        updateHUD();
      }
    }
  }

  // ---------------------------------------------------------------
  //  Обновление физики набивания
  // ---------------------------------------------------------------
  function updatePlay(dt) {
    ball.vy += GRAVITY * dt;
    ball.y  += ball.vy * dt;
    ball.x  += ball.vx * dt;
    ball.vx *= 0.98;
    ball.angle += ball.spin * dt;

    // стенки слева/справа
    if (ball.x < ball.r + 6)      { ball.x = ball.r + 6;      ball.vx = Math.abs(ball.vx); }
    if (ball.x > GW - ball.r - 6) { ball.x = GW - ball.r - 6; ball.vx = -Math.abs(ball.vx); }

    // упал
    if (ball.y - ball.r > FLOOR_Y) {
      dropBall();
    }

    // прокрутка мира — "идём" пока мяч в воздухе
    game.worldX += dt * 26;

    if (footKick > 0) footKick = Math.max(0, footKick - dt * 4);
    if (lifeFlash > 0) lifeFlash = Math.max(0, lifeFlash - dt * 2);
  }

  // ===============================================================
  //  ОТРИСОВКА
  // ===============================================================

  // -- утилита: пиксельный прямоугольник
  function rect(x, y, w, h, color) { ctx.fillStyle = color; ctx.fillRect(x|0, y|0, w|0, h|0); }

  // -- Parallax фон (небо, горы, облака, холмы, земля)
  function drawBackground(keeperScene) {
    // небо — градиент закатного 16-бит
    const sky = ctx.createLinearGradient(0, 0, 0, GH);
    sky.addColorStop(0, '#3b2a6b');
    sky.addColorStop(0.45, '#7b4aa0');
    sky.addColorStop(0.7, '#e98a6b');
    sky.addColorStop(1, '#f4c06b');
    rect(0, 0, GW, GH, '#000');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, GW, GH);

    // солнце
    rect(135, 40, 28, 28, '#ffe9a8');
    rect(131, 44, 36, 20, '#ffe9a8');

    // облака — двигаются медленнее всего
    drawClouds(game.worldX * 0.15);

    // дальние горы — медленно (привязаны к земле)
    drawMountains(game.worldX * 0.3, FLOOR_Y - 155, '#5a3c7a', 70);
    drawMountains(game.worldX * 0.45, FLOOR_Y - 135, '#704a8c', 55);

    // холмы поближе
    drawHills(game.worldX * 0.7, FLOOR_Y - 95, '#3f7a3a');
    drawHills(game.worldX * 1.0 + 40, FLOOR_Y - 72, '#2f5f2c');

    // земля
    rect(0, FLOOR_Y - 2, GW, GH - FLOOR_Y + 2, '#6b4a2a');
    rect(0, FLOOR_Y - 2, GW, 5, '#3f7a3a');
    // полоски травы бегут навстречу (ощущение движения)
    ctx.fillStyle = '#2f5f2c';
    const step = 26;
    const sft = (game.worldX * 1.4) % step;
    for (let x = -step; x < GW + step; x += step) {
      ctx.fillRect((x - sft) | 0, FLOOR_Y + 6, 12, 3);
    }

    if (keeperScene) drawGoal();
  }

  function drawClouds(off) {
    const w = GW + 80;
    for (let i = 0; i < 4; i++) {
      let cx = (i * 70 - (off % w) + w) % w - 40;
      const cy = 30 + (i % 2) * 26;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      rect(cx, cy, 30, 9, '#fdf3e3');
      rect(cx + 6, cy - 5, 20, 9, '#fdf3e3');
      rect(cx + 14, cy - 8, 14, 12, '#fdf3e3');
    }
  }

  function drawMountains(off, baseY, color, h) {
    const span = 90;
    ctx.fillStyle = color;
    for (let i = -1; i < 4; i++) {
      let mx = i * span - (off % span);
      ctx.beginPath();
      ctx.moveTo(mx, baseY);
      ctx.lineTo(mx + span / 2, baseY - h);
      ctx.lineTo(mx + span, baseY);
      ctx.closePath();
      ctx.fill();
      // снежная шапка
      ctx.fillStyle = '#e8e0f0';
      ctx.beginPath();
      ctx.moveTo(mx + span / 2 - 9, baseY - h + 14);
      ctx.lineTo(mx + span / 2, baseY - h);
      ctx.lineTo(mx + span / 2 + 9, baseY - h + 14);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = color;
    }
  }

  function drawHills(off, baseY, color) {
    const span = 70;
    ctx.fillStyle = color;
    for (let i = -1; i < 5; i++) {
      let hx = i * span - (off % span);
      ctx.beginPath();
      ctx.arc(hx + span / 2, baseY + 30, 45, Math.PI, 0);
      ctx.fill();
    }
    ctx.fillRect(0, baseY + 28, GW, 8);
  }

  // -- Ворота + вратарь (мини-игра)
  function drawGoal() {
    const g = GOAL;
    // сетка
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    for (let x = g.x; x <= g.x + g.w; x += 10) {
      ctx.beginPath(); ctx.moveTo(x, g.y); ctx.lineTo(x, g.y + g.h); ctx.stroke();
    }
    for (let y = g.y; y <= g.y + g.h; y += 10) {
      ctx.beginPath(); ctx.moveTo(g.x, y); ctx.lineTo(g.x + g.w, y); ctx.stroke();
    }
    // штанги
    rect(g.x - 4, g.y - 4, 4, g.h + 8, '#ffffff');
    rect(g.x + g.w, g.y - 4, 4, g.h + 8, '#ffffff');
    rect(g.x - 4, g.y - 4, g.w + 8, 4, '#ffffff');

    // прицел (видим пока целимся и пока летит мяч — чтобы видеть попадание)
    if (keeper.phase === 'aim' || keeper.phase === 'ready' || keeper.phase === 'shoot') {
      const ax = g.x + keeper.aimX * g.w;
      const ay = g.y + keeper.aimY * g.h;
      ctx.strokeStyle = '#ff4d4d';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(ax, ay, 8, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ax - 12, ay); ctx.lineTo(ax + 12, ay); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ax, ay - 12); ctx.lineTo(ax, ay + 12); ctx.stroke();
    }

    // вратарь
    // cx/cy — центр груди вратаря (двигается и по X, и по Y)
    drawKeeper(g.x + keeper.keeperX * g.w, g.y + keeper.keeperY * g.h);
  }

  function drawKeeper(cx, cy) {
    const diving = keeper.phase === 'shoot' || keeper.phase === 'result';
    const wave = Math.sin(keeper.armWave) * 5;
    // ноги
    rect(cx - 7, cy + 9, 6, 9, '#222');
    rect(cx + 1, cy + 9, 6, 9, '#222');
    // майка
    rect(cx - 7, cy - 11, 14, 20, '#d8362f');
    // голова
    rect(cx - 5, cy - 22, 10, 10, '#f0c090');
    // руки + перчатки
    if (diving) {
      // тянется в обе стороны (в прыжке)
      rect(cx - 24, cy - 14, 17, 5, '#f0c090');   // левая рука
      rect(cx + 7,  cy - 14, 17, 5, '#f0c090');   // правая рука
      rect(cx - 28, cy - 16, 6, 8, '#ffffff');    // левая перчатка
      rect(cx + 22, cy - 16, 6, 8, '#ffffff');    // правая перчатка
    } else {
      // машет руками (ждёт удар)
      rect(cx - 16, cy - 12 + wave, 10, 5, '#f0c090');
      rect(cx + 6,  cy - 12 - wave, 10, 5, '#f0c090');
      rect(cx - 19, cy - 14 + wave, 5, 7, '#ffffff');
      rect(cx + 15, cy - 16 - wave, 5, 7, '#ffffff');
    }
  }

  // -- Мяч (классический, крутится)
  function drawBall() {
    ctx.save();
    ctx.translate(ball.x, ball.y);
    ctx.rotate(ball.angle);
    // белый круг
    ctx.fillStyle = '#fdfdfd';
    ctx.beginPath(); ctx.arc(0, 0, ball.r, 0, Math.PI * 2); ctx.fill();
    // обводка
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#b8b8b8';
    ctx.beginPath(); ctx.arc(0, 0, ball.r, 0, Math.PI * 2); ctx.stroke();
    // центральный пятиугольник
    ctx.fillStyle = '#222';
    drawPenta(0, 0, ball.r * 0.42);
    // боковые "пятна"
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const px = Math.cos(a) * ball.r * 0.72;
      const py = Math.sin(a) * ball.r * 0.72;
      ctx.beginPath(); ctx.arc(px, py, ball.r * 0.16, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  function drawPenta(cx, cy, r) {
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + i * (Math.PI * 2 / 5);
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath(); ctx.fill();
  }

  // -- Нога в кроссовке (справа-внизу), анимация удара
  function drawFoot() {
    const lift = footKick * 16;           // подъём при ударе
    const baseX = 150, baseY = FLOOR_Y - 4;
    ctx.save();
    ctx.translate(baseX, baseY - lift);
    ctx.rotate(-footKick * 0.5);

    // голень (джинсы/шорты + кожа)
    rect(6, -2, 16, 60, '#2a4a8a');        // штанина (уходит за низ экрана)
    rect(8, 0, 12, 14, '#f0c090');          // кожа над носком
    // носок
    rect(2, 12, 22, 9, '#e8e8e8');
    rect(2, 12, 22, 3, '#d8362f');          // полоска на носке
    // кроссовка
    rect(-12, 18, 36, 12, '#ffffff');       // верх кроссовка
    rect(-12, 26, 40, 6, '#d8362f');        // подошва
    rect(-12, 18, 10, 12, '#2a6ad8');       // цветной мысок
    rect(6, 20, 14, 3, '#cccccc');          // шнурки-намёк
    ctx.restore();
  }

  // ---------------------------------------------------------------
  //  Главный цикл
  // ---------------------------------------------------------------
  let last = 0;
  function loop(ts) {
    if (!last) last = ts;
    let dt = (ts - last) / 1000;
    last = ts;
    if (dt > 0.05) dt = 0.05;             // защита от больших скачков

    // -- update (на паузе мир замирает, но продолжаем рисовать)
    if (!paused) {
      if (state === STATE.PLAY)  updatePlay(dt);
      if (state === STATE.KEEPER) updateKeeper(dt);
    }

    // -- draw
    drawBackground(state === STATE.KEEPER);
    if (state === STATE.KEEPER) {
      drawBall();
    } else if (state === STATE.PLAY) {
      drawFoot();
      drawBall();
    } else {
      drawFoot();
    }

    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

})();
