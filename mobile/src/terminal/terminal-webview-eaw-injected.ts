// East Asian Ambiguous width + Orca unicode activation for the mobile WebView IIFE (#9958).
// Mirrors desktop/headless: Unicode11 base + Orca provider, optional wide mode CJK fonts.

export const TERMINAL_EAW_JS = `
  // Why: wide EAW mode needs full-em CJK glyphs ahead of Consolas (#9958 desktop parity).
  var CJK_AMBIGUOUS_FALLBACKS = '"Malgun Gothic", "Microsoft YaHei", "Yu Gothic", "Apple SD Gothic Neo", "PingFang SC", "Hiragino Sans", "Noto Sans CJK KR", "Noto Sans CJK SC", "Noto Sans CJK JP"';
  // Why: process-wide for this WebView document; set before first write via init.
  var eastAsianAmbiguousWidthMode = 'narrow';
  function buildTerminalFontFamily() {
    var lead = isIOSWebView() ? 'ui-monospace, ' : '"SF Mono", ';
    if (eastAsianAmbiguousWidthMode === 'wide') {
      // Why: insert CJK before Consolas so ambiguous glyphs fill the two-cell slot.
      return lead + '"Menlo", "Monaco", "Cascadia Mono", ' + CJK_AMBIGUOUS_FALLBACKS + ', "Consolas", "DejaVu Sans Mono", "Liberation Mono", "Symbols Nerd Font Mono", monospace';
    }
    return lead + TERMINAL_FONT_FALLBACKS;
  }
  function applyEastAsianAmbiguousWidthMode(nextMode) {
    if (nextMode === 'wide' || nextMode === 'narrow') {
      eastAsianAmbiguousWidthMode = nextMode;
    }
  }
  function activateOrcaUnicodeOnTerm(termInstance) {
    // Why: load Unicode11 then Orca's ZWJ + East Asian Ambiguous provider (desktop/headless parity).
    // Previously mobile stopped at Unicode11 and bypassed the Orca width tables entirely.
    if (window.Unicode11Addon && window.Unicode11Addon.Unicode11Addon) {
      try {
        termInstance.loadAddon(new window.Unicode11Addon.Unicode11Addon());
        termInstance.unicode.activeVersion = '11';
      } catch (e) {}
    }
    if (window.OrcaTerminalUnicode) {
      try {
        window.OrcaTerminalUnicode.setEastAsianAmbiguousWidthMode(eastAsianAmbiguousWidthMode);
        window.OrcaTerminalUnicode.activate(termInstance);
      } catch (e) {}
    }
  }
`
