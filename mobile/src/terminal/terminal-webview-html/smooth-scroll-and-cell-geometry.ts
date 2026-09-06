export const TERMINAL_HTML_SMOOTH_SCROLL_AND_CELL_GEOMETRY = `  function clampNormalScrollLines(lines) {
    if (!term || !term.buffer || !term.buffer.active || lines === 0) return 0;
    var buffer = term.buffer.active;
    if (lines > 0) {
      return Math.min(lines, Math.max(0, buffer.baseY - buffer.viewportY));
    }
    return Math.max(lines, -buffer.viewportY);
  }

  function canScrollNormalBufferDelta(deltaY) {
    if (!term || !term.buffer || !term.buffer.active || deltaY === 0) return false;
    var buffer = term.buffer.active;
    if (deltaY > 0) return buffer.viewportY < buffer.baseY;
    return buffer.viewportY > 0;
  }

  function applyNormalBufferScrollDelta(deltaY) {
    if (!term || deltaY === 0) return false;
    var effectiveCellH = getCellHeight() * getTotalScale();
    if (effectiveCellH <= 0) return false;
    if (!canScrollNormalBufferDelta(deltaY)) {
      resetSmoothScrollOffset();
      return false;
    }
    smoothScrollOffsetY -= deltaY;
    var lines = Math.trunc(-smoothScrollOffsetY / effectiveCellH);
    if (lines !== 0) {
      var applied = clampNormalScrollLines(lines);
      if (applied !== 0) {
        term.scrollLines(applied);
        // Why: xterm's renderer is row-based. Buffer touch pixels and only
        // commit whole rows so TUI canvas layers do not shimmer between
        // fractional transforms and xterm repaints.
        smoothScrollOffsetY += applied * effectiveCellH;
      }
      if (applied !== lines) smoothScrollOffsetY = 0;
    }
    var limit = effectiveCellH - 1;
    if (smoothScrollOffsetY > limit) smoothScrollOffsetY = limit;
    if (smoothScrollOffsetY < -limit) smoothScrollOffsetY = -limit;
    updateScrollIndicator(true);
    return true;
  }

  function enqueueNormalBufferScrollDelta(deltaY) {
    if (!term || deltaY === 0) return false;
    if (!canScrollNormalBufferDelta(deltaY)) {
      resetSmoothScrollOffset();
      return false;
    }
    pendingNormalScrollDeltaY += deltaY;
    if (normalScrollFrameId !== null) return true;
    // Why: dense terminal rows are expensive to repaint. Coalesce touchmove
    // deltas into one xterm row-scroll per frame instead of repainting from
    // the input event stream.
    normalScrollFrameId = requestAnimationFrame(function() {
      normalScrollFrameId = null;
      var delta = pendingNormalScrollDeltaY;
      pendingNormalScrollDeltaY = 0;
      if (!applyNormalBufferScrollDelta(delta)) {
        resetSmoothScrollOffset();
      }
    });
    return true;
  }

  function resetSmoothScrollOffset() {
    pendingNormalScrollDeltaY = 0;
    if (normalScrollFrameId !== null) {
      cancelAnimationFrame(normalScrollFrameId);
      normalScrollFrameId = null;
    }
    if (smoothScrollOffsetY === 0) return;
    smoothScrollOffsetY = 0;
    updateScrollIndicator(false);
  }

  function cellToViewportPx(col, absRow) {
    if (!term) return { x: 0, y: 0 };
    var cellW = getCellWidth();
    var cellH = getCellHeight();
    var viewportRow = absRow - term.buffer.active.viewportY;
    var sx = col * cellW;
    var sy = viewportRow * cellH;
    var total = getTotalScale();
    return { x: sx * total + panX, y: sy * total + panY };
  }

  function getLineText(absRow) {
    if (!term) return '';
    var line = term.buffer.active.getLine(absRow);
    if (!line) return '';
    return line.translateToString(false);
  }

  // Why: getLineText collapses wide chars (emoji, CJK) to one string char, so a
  // tap's CELL column no longer equals the STRING index that url/path matchers use.
  // Convert by measuring the string length up to the tapped cell (the count of
  // string chars before it). Without this, taps on lines with a leading wide char
  // (e.g. agent output prefixed with ⏺) resolve to the wrong column and miss.
  function cellColToStringIndex(absRow, col) {
    if (!term) return col;
    var line = term.buffer.active.getLine(absRow);
    if (!line) return col;
    return line.translateToString(false, 0, col).length;
  }

  // File-path-under-tap detection (matchFilePathAtColumn). See
  // terminal-path-tap-injected.ts; mirrors the unit-tested terminal-path-tap.ts.
`
