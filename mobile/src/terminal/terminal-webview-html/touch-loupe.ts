// Press-and-hold touch loupe injected into XTERM_HTML, as its own concern
// module per the terminal-webview-html/ split. Closes over host-IIFE
// state/functions: term, surface, handleStart/handleEnd, sel/selMode, selRange,
// viewportToCell, getCellWidth/getCellHeight, getTotalScale, panX/panY,
// terminalTheme, terminalFontFamily, plus the color helpers from
// touch-loupe-colors.ts (spliced in just before this fragment).
export const TERMINAL_HTML_TOUCH_LOUPE = `
  // ============================================================
  // TOUCH LOUPE (press-and-hold magnifier)
  // ============================================================
  var LOUPE_ACTIVATE_MS = 150;
  // Why: zoom the UNSCALED css cell, not the on-screen cell — the fit scale
  // already shrinks on-screen cells to ~0.3-0.6x, so 2x of that would magnify
  // nothing. 2x of the true cell size is ~6-10x apparent magnification.
  var LOUPE_ZOOM = 2;
  var LOUPE_COLS = 17;
  var LOUPE_ROWS = 5;
  var LOUPE_GAP_PX = 76;
  var LOUPE_EDGE_MARGIN = 8;
  var LOUPE_MAX_DPR = 3;

  function loupeClamp(value, lo, hi) {
    return Math.max(lo, Math.min(hi, value));
  }

  // Buffer-absolute row/col window centered on the finger cell, clamped so the
  // window never runs past the grid or past the buffer bounds (in the alternate
  // buffer, length === rows, so this clamps to the screen).
  function loupeWindow(centerCol, centerRow, cols, bufferLength) {
    var startCol = loupeClamp(centerCol - ((LOUPE_COLS - 1) >> 1), 0, Math.max(0, cols - LOUPE_COLS));
    var lastRow = Math.max(0, bufferLength - 1);
    var startRow = loupeClamp(centerRow - ((LOUPE_ROWS - 1) >> 1), 0, Math.max(0, lastRow - LOUPE_ROWS + 1));
    return { startCol: startCol, startRow: startRow };
  }

  // Viewport placement for the bubble: centered above the finger, horizontally
  // clamped, flipping below the finger near the top edge (the same
  // clamp-then-flip shape repositionOverlay uses for the Copy pill).
  function loupeLayout(pointX, pointY, w, h, viewportW, viewportH) {
    var left = loupeClamp(pointX - w / 2, LOUPE_EDGE_MARGIN, Math.max(LOUPE_EDGE_MARGIN, viewportW - w - LOUPE_EDGE_MARGIN));
    var above = (pointY - LOUPE_GAP_PX - h) >= LOUPE_EDGE_MARGIN;
    var top;
    if (above) {
      top = pointY - LOUPE_GAP_PX - h;
    } else {
      top = Math.min(pointY + LOUPE_GAP_PX, Math.max(LOUPE_EDGE_MARGIN, viewportH - h - LOUPE_EDGE_MARGIN));
    }
    return { left: left, top: top, above: above };
  }

  var loupeEl = document.getElementById('touch-loupe');
  var loupeCanvas = document.getElementById('touch-loupe-canvas');
  var loupeCtx = null;
  var loupePalette = null;
  var loupePaletteTheme = null;
  var loupeState = 'idle'; // 'idle' | 'pending' | 'visible'
  var loupeTouchId = null;
  var loupePoint = null; // { x, y } client coords of the tracked finger
  var loupeShowTimer = null;
  var loupeFrameId = null;

  function loupeInsideSurface(target) {
    if (!surface || !target) return false;
    return surface.contains(target);
  }

  function loupeTouchById(touches, id) {
    if (id === null) return null;
    for (var i = 0; i < touches.length; i++) {
      if (touches[i].identifier === id) return touches[i];
    }
    return null;
  }

  function loupeShow() {
    if (loupeShowTimer !== null) { clearTimeout(loupeShowTimer); loupeShowTimer = null; }
    loupeState = 'visible';
    // Why: no transition/opacity ramp — nothing to gate on reduced-motion and
    // no extra frames beyond the tracking loop.
    loupeEl.style.display = 'block';
    if (loupeFrameId === null) loupeFrameId = requestAnimationFrame(loupeFrame);
  }

  function loupeHide() {
    if (loupeShowTimer !== null) { clearTimeout(loupeShowTimer); loupeShowTimer = null; }
    if (loupeFrameId !== null) { cancelAnimationFrame(loupeFrameId); loupeFrameId = null; }
    loupeState = 'idle';
    loupePoint = null;
    loupeTouchId = null;
    loupeEl.style.display = 'none';
  }

  function loupeShowLater() {
    if (loupeState !== 'idle') return;
    loupeState = 'pending';
    loupeShowTimer = setTimeout(loupeShow, LOUPE_ACTIVATE_MS);
  }

  function loupeFrame() {
    loupeFrameId = null;
    if (loupeState !== 'visible') return;
    // Why: continuous rAF rather than event-driven redraws — the content under
    // a held finger changes via scroll/momentum, edge auto-scroll, new output,
    // eviction and reflow, none observable from a self-contained fragment.
    if (!loupeDraw()) { loupeHide(); return; }
    loupeFrameId = requestAnimationFrame(loupeFrame);
  }

  // Why: returning false retracts the loupe — a missing term/metrics/canvas
  // (pre-init, engine failure, headless tests) must never break the touch path.
  function loupeCss(rgb) {
    return 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
  }

  // Mirror init()'s fontWeight 300 / fontWeightBold 500 so loupe glyphs match
  // the main renderer's weight.
  function loupeFont(px, bold, italic) {
    return (italic ? 'italic ' : '') + (bold ? '500' : '300') + ' ' + Math.round(px) + 'px ' + terminalFontFamily;
  }

  function loupeEnsurePalette() {
    if (loupePaletteTheme === terminalTheme && loupePalette) return loupePalette;
    loupePalette = loupeBuildPalette(terminalTheme);
    loupePaletteTheme = terminalTheme;
    return loupePalette;
  }

  function loupeCellInRange(range, row, col) {
    if (!range) return false;
    if (row < range.start.row || row > range.end.row) return false;
    if (row === range.start.row && col < range.start.col) return false;
    if (row === range.end.row && col > range.end.col) return false;
    return true;
  }

  function loupeDraw() {
    if (!term || !term.buffer || !term.buffer.active || !loupePoint) return false;
    if (loupeCtx === null) {
      try { loupeCtx = loupeCanvas.getContext('2d'); } catch (e) { loupeCtx = null; }
      if (!loupeCtx) return false;
    }
    var buffer = term.buffer.active;
    var cellW = getCellWidth();
    var cellH = getCellHeight();
    if (cellW <= 0 || cellH <= 0) return false;
    var center = viewportToCell(loupePoint.x, loupePoint.y);
    if (!center) return false;
    var region = loupeWindow(center.col, center.row, term.cols, buffer.length);
    var zoomW = cellW * LOUPE_ZOOM;
    var zoomH = cellH * LOUPE_ZOOM;
    var w = LOUPE_COLS * zoomW;
    var h = LOUPE_ROWS * zoomH;
    // Why: draw in css px on a devicePixelRatio-sized backing store so glyphs
    // rasterize crisp instead of upscaling a 1x bitmap.
    var dpr = Math.min(LOUPE_MAX_DPR, Math.max(1, window.devicePixelRatio || 1));
    var bw = Math.round(w * dpr);
    var bh = Math.round(h * dpr);
    if (loupeCanvas.width !== bw) loupeCanvas.width = bw;
    if (loupeCanvas.height !== bh) loupeCanvas.height = bh;
    loupeCanvas.style.width = w + 'px';
    loupeCanvas.style.height = h + 'px';
    loupeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var theme = terminalTheme;
    loupeCtx.fillStyle = loupeCss(loupeThemeRgb(theme.background, [26, 27, 38]));
    loupeCtx.fillRect(0, 0, w, h);

    var palette = loupeEnsurePalette();
    var range = null;
    if (selMode === 'select') {
      try { range = selRange(); } catch (e) { range = null; }
    }
    var selBg = loupeThemeRgb(theme.selectionBackground, [51, 70, 124]);
    var selFg = loupeThemeRgb(theme.selectionForeground, [192, 202, 245]);
    var accentRgb = loupeThemeRgb(theme.cursor, [192, 202, 245]);
    for (var i = 0; i < LOUPE_ROWS; i++) {
      var row = region.startRow + i;
      if (row < 0 || row >= buffer.length) continue;
      var line = buffer.getLine(row);
      if (!line) continue;
      for (var j = 0; j < LOUPE_COLS; j++) {
        var col = region.startCol + j;
        if (col < 0 || col >= term.cols) continue;
        var cell = line.getCell(col);
        if (!cell) continue;
        var width = cell.getWidth ? cell.getWidth() : 1;
        // Why: width 0 is the filler half of a wide char whose glyph is drawn
        // at the wide char's left cell.
        if (width === 0) continue;
        var fg = loupeCellColor(cell, true, palette, theme);
        var bg = loupeCellColor(cell, false, palette, theme);
        if (cell.isInverse && cell.isInverse()) {
          var swapped = fg; fg = bg; bg = swapped;
        }
        if (loupeCellInRange(range, row, col)) { bg = selBg; fg = selFg; }
        if (cell.isDim && cell.isDim()) {
          fg = [Math.round(fg[0] * 0.6), Math.round(fg[1] * 0.6), Math.round(fg[2] * 0.6)];
        }
        var x = j * zoomW;
        var y = i * zoomH;
        loupeCtx.fillStyle = loupeCss(bg);
        loupeCtx.fillRect(x, y, zoomW, zoomH);
        var chars = cell.getChars ? cell.getChars() : '';
        if (chars && !(cell.isInvisible && cell.isInvisible())) {
          loupeCtx.font = loupeFont(zoomH, !!(cell.isBold && cell.isBold()), !!(cell.isItalic && cell.isItalic()));
          loupeCtx.textBaseline = 'middle';
          loupeCtx.textAlign = width === 2 ? 'left' : 'center';
          loupeCtx.fillStyle = loupeCss(fg);
          if (width === 2) loupeCtx.fillText(chars, x, y + zoomH / 2);
          else loupeCtx.fillText(chars, x + zoomW / 2, y + zoomH / 2);
        }
        var decoWeight = Math.max(1, Math.round(zoomH / 15));
        if (cell.isUnderline && cell.isUnderline()) {
          loupeCtx.fillStyle = loupeCss(fg);
          loupeCtx.fillRect(x, y + zoomH - decoWeight, zoomW, decoWeight);
        }
        if (cell.isStrikethrough && cell.isStrikethrough()) {
          loupeCtx.fillStyle = loupeCss(fg);
          loupeCtx.fillRect(x, y + zoomH / 2 - decoWeight / 2, zoomW, decoWeight);
        }
      }
    }

    // Caret bar at the cursor cell when it is inside the magnified region.
    try {
      var cursorRow = buffer.cursorY + buffer.viewportY;
      var cursorCol = buffer.cursorX;
      if (
        cursorRow >= region.startRow && cursorRow < region.startRow + LOUPE_ROWS &&
        cursorCol >= region.startCol && cursorCol < region.startCol + LOUPE_COLS
      ) {
        loupeCtx.fillStyle = loupeCss(accentRgb);
        loupeCtx.fillRect(
          (cursorCol - region.startCol) * zoomW,
          (cursorRow - region.startRow) * zoomH,
          2, zoomH
        );
      }
    } catch (e) {}

    // Crosshair on the exact finger point (sub-cell precision).
    var total = getTotalScale();
    if (total <= 0) total = 1;
    var fracX = ((loupePoint.x - panX) / total) / cellW - center.col;
    var fracY = ((loupePoint.y - panY) / total) / cellH - (center.row - buffer.viewportY);
    var crossX = (center.col - region.startCol + 0.5 + fracX) * zoomW;
    var crossY = (center.row - region.startRow + 0.5 + fracY) * zoomH;
    if (crossX >= 0 && crossX <= w && crossY >= 0 && crossY <= h) {
      loupeCtx.fillStyle = loupeCss(accentRgb);
      loupeCtx.fillRect(crossX - zoomW / 2, crossY - 0.5, zoomW, 1);
      loupeCtx.fillRect(crossX - 0.5, crossY - zoomH / 2, 1, zoomH);
    }

    var layout = loupeLayout(loupePoint.x, loupePoint.y, w, h, window.innerWidth, window.innerHeight);
    loupeEl.style.left = layout.left + 'px';
    loupeEl.style.top = layout.top + 'px';
    return true;
  }

  // Zero-interference contract: capture + passive, never preventDefault or
  // stopPropagation, so the dispatcher/surface gesture pipeline is untouched.
  document.addEventListener('touchstart', function(e) {
    if (e.touches.length !== 1) { loupeHide(); return; }
    var t = e.touches[0];
    loupeTouchId = t.identifier;
    loupePoint = { x: t.clientX, y: t.clientY };
    if (e.target === handleStart || e.target === handleEnd) { loupeShow(); return; }
    if (!loupeInsideSurface(e.target)) { loupeHide(); return; }
    loupeShowLater();
  }, { capture: true, passive: true });

  document.addEventListener('touchmove', function(e) {
    if (loupeState === 'idle' || !loupePoint) return;
    // Why: the delay is not reset by movement — a pan that starts immediately
    // must still surface the loupe at the hold threshold.
    var t = loupeTouchById(e.touches, loupeTouchId) || e.touches[0];
    if (t) { loupePoint.x = t.clientX; loupePoint.y = t.clientY; }
  }, { capture: true, passive: true });

  document.addEventListener('touchend', function() { loupeHide(); }, { capture: true, passive: true });
  document.addEventListener('touchcancel', function() { loupeHide(); }, { capture: true, passive: true });
`
