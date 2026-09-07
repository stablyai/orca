export const TERMINAL_KEYBOARD_AVOIDANCE_METRICS_JS = `
  function lineHasVisibleContent(line, cell) {
    if (line.translateToString(true).trim().length > 0) return true;
    if (!cell || !line.getCell) return false;
    var limit = Math.min(term.cols || 0, line.length || 0);
    for (var x = 0; x < limit; x++) {
      var current = line.getCell(x, cell);
      if (!current) continue;
      if (!current.isBgDefault() || current.isInverse()) return true;
      if (typeof current.isUnderline === 'function' && current.isUnderline()) return true;
      if (typeof current.isStrikethrough === 'function' && current.isStrikethrough()) return true;
      if (typeof current.isOverline === 'function' && current.isOverline()) return true;
    }
    return false;
  }

  function computeContentBottomRow() {
    if (!term || !term.buffer || !term.buffer.active) return 0;
    var buffer = term.buffer.active;
    var top = buffer.viewportY || 0;
    var cell = buffer.getNullCell ? buffer.getNullCell() : null;
    for (var y = (term.rows || 0) - 1; y >= 0; y--) {
      try {
        var line = buffer.getLine(top + y);
        if (line && lineHasVisibleContent(line, cell)) return y;
      } catch (e) {}
    }
    return 0;
  }

  function emitKeyboardAvoidanceMetrics() {
    if (!term) return;
    var alt = false;
    try { alt = term.buffer && term.buffer.active && term.buffer.active.type === 'alternate'; } catch (e) {}
    notify({
      type: 'keyboard-avoidance-metrics',
      cursorY: term.buffer && term.buffer.active ? term.buffer.active.cursorY : 0,
      contentBottomRow: alt ? 0 : computeContentBottomRow(),
      rows: term.rows || 0,
      altScreen: alt
    });
  }
`
