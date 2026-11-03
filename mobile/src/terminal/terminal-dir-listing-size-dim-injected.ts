// Visual-only dim of trailing directory-listing size tokens inside the terminal
// WebView. Injected into XTERM_HTML; mirrors matchTrailingDirListingSize in
// terminal-dir-listing-size-dim.ts (unit-tested source of truth).
//
// Decorations overlay the size cells with the terminal background at partial
// opacity so the buffer, selection, and copy stay byte-identical to the PTY.

export const TERMINAL_DIR_LISTING_SIZE_DIM_JS = String.raw`
  var dimDirListingSizesEnabled = false;
  var sizeDimDecorations = [];
  var sizeDimRefreshScheduled = false;
  var SIZE_TOKEN_RE = /(\d+(?:\.\d+)?)([KMGT]B?|B)\s*$/i;

  function matchTrailingDirListingSize(lineText) {
    if (!lineText) return null;
    var match = SIZE_TOKEN_RE.exec(lineText);
    if (!match || match.index === undefined) return null;
    var tokenStart = match.index;
    if (tokenStart === 0) return null;
    if (!/\s/.test(lineText.charAt(tokenStart - 1))) return null;
    var prefixEnd = tokenStart;
    while (prefixEnd > 0 && /\s/.test(lineText.charAt(prefixEnd - 1))) prefixEnd -= 1;
    if (prefixEnd === 0) return null;
    var token = match[1] + match[2];
    return { start: tokenStart, end: tokenStart + token.length };
  }

  function stringIndexToCellCol(line, stringIndex) {
    if (!line || stringIndex <= 0) return 0;
    var consumed = 0;
    for (var col = 0; col < line.length; col++) {
      if (consumed >= stringIndex) return col;
      var cell = line.getCell(col);
      if (!cell) return col;
      var chars = cell.getChars();
      if (chars) consumed += chars.length;
    }
    return line.length;
  }

  function clearSizeDimDecorations() {
    for (var i = 0; i < sizeDimDecorations.length; i++) {
      // Why: IDecoration.dispose leaves the linked IMarker alive in the buffer.
      try { sizeDimDecorations[i].marker.dispose(); } catch (e) {}
      try { sizeDimDecorations[i].dispose(); } catch (e) {}
    }
    sizeDimDecorations = [];
  }

  function refreshSizeDimDecorations() {
    sizeDimRefreshScheduled = false;
    clearSizeDimDecorations();
    if (!dimDirListingSizesEnabled || !term || typeof term.registerMarker !== 'function') return;
    var buf = term.buffer.active;
    var baseY = buf.baseY;
    var cursorY = buf.cursorY;
    // Why: body.style.background is empty when the theme is only set via xterm options.
    var bg = (typeof terminalTheme !== 'undefined' && terminalTheme && terminalTheme.background) ||
      (typeof defaultTheme !== 'undefined' && defaultTheme.background) ||
      '#1a1b26';
    for (var row = 0; row < term.rows; row++) {
      var absRow = baseY + row;
      var line = buf.getLine(absRow);
      if (!line) continue;
      var text = line.translateToString(false);
      var range = matchTrailingDirListingSize(text);
      if (!range) continue;
      var startCol = stringIndexToCellCol(line, range.start);
      var endCol = stringIndexToCellCol(line, range.end);
      var width = Math.max(1, endCol - startCol);
      var marker;
      try {
        marker = term.registerMarker(row - cursorY);
      } catch (e) {
        continue;
      }
      if (!marker) continue;
      var decoration;
      try {
        decoration = term.registerDecoration({
          marker: marker,
          x: startCol,
          width: width,
          layer: 'top'
        });
      } catch (e) {
        try { marker.dispose(); } catch (e2) {}
        continue;
      }
      if (!decoration) {
        try { marker.dispose(); } catch (e) {}
        continue;
      }
      decoration.onRender(function (element) {
        element.style.background = bg;
        element.style.opacity = '0.62';
        element.style.pointerEvents = 'none';
      });
      sizeDimDecorations.push(decoration);
    }
  }

  function scheduleSizeDimRefresh() {
    if (!dimDirListingSizesEnabled || sizeDimRefreshScheduled) return;
    sizeDimRefreshScheduled = true;
    requestAnimationFrame(refreshSizeDimDecorations);
  }

  function setDimDirListingSizes(enabled) {
    dimDirListingSizesEnabled = !!enabled;
    if (!dimDirListingSizesEnabled) {
      clearSizeDimDecorations();
      return;
    }
    scheduleSizeDimRefresh();
  }
`
