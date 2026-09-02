import { colors } from '../theme/mobile-theme'

// Theme normalization and page-surface painting injected into the WebView IIFE.
// Mirrors the desktop minimumContrastRatio gate (src/renderer/src/lib/terminal-contrast-correction.ts,
// #7934/#10104): a dark composed background gets a mild floor of 3 to rescue near-background body text
// (e.g. Antigravity's #262b30 on #1e242a) without over-brightening vibrant ANSI colors; a light
// background keeps the WCAG-AA 4.5 floor. Gate on the composed background luminance, not app mode,
// because either theme slot can hold either kind of theme.
export const TERMINAL_WEBVIEW_THEME_JS = `
  var DARK_BG_MIN_CONTRAST = 3;
  var LIGHT_BG_MIN_CONTRAST = 4.5;
  // Dark app surface a transparent terminal background composites over (matches desktop APP_SURFACE_COLORS.dark).
  var CONTRAST_APP_SURFACE = { r: 10, g: 10, b: 10 };

  function parseTerminalBackgroundRgba(value) {
    if (typeof value !== 'string') return null;
    var v = value.trim().toLowerCase();
    if (!v) return null;
    if (v === 'black') return { r: 0, g: 0, b: 0, a: 1 };
    if (v === 'white') return { r: 255, g: 255, b: 255, a: 1 };
    if (v === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    var hex = v.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/);
    if (hex) {
      var h = hex[1];
      var ch;
      if (h.length === 3 || h.length === 4) {
        ch = h.split('').map(function (p) { return parseInt(p + p, 16); });
      } else {
        ch = [];
        for (var i = 0; i < h.length; i += 2) ch.push(parseInt(h.slice(i, i + 2), 16));
      }
      return { r: ch[0], g: ch[1], b: ch[2], a: ch[3] === undefined ? 1 : ch[3] / 255 };
    }
    var rgb = v.match(/^rgba?\\(([^)]+)\\)$/);
    if (!rgb) return null;
    var parts = rgb[1].indexOf(',') >= 0 ? rgb[1].split(',') : rgb[1].split(/[\\s/]+/);
    parts = parts.map(function (p) { return p.trim(); }).filter(function (p) { return p.length > 0; });
    if (parts.length < 3) return null;
    var channel = function (p) {
      var n = p.charAt(p.length - 1) === '%' ? (parseFloat(p) / 100) * 255 : parseFloat(p);
      return isFinite(n) ? Math.min(255, Math.max(0, Math.round(n))) : null;
    };
    var r = channel(parts[0]), g = channel(parts[1]), b = channel(parts[2]);
    if (r === null || g === null || b === null) return null;
    var a = 1;
    if (parts[3] !== undefined) {
      var raw = parts[3].charAt(parts[3].length - 1) === '%' ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
      a = isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 1;
    }
    return { r: r, g: g, b: b, a: a };
  }

  function terminalRelativeLuminance(rgb) {
    var lin = function (c) {
      var n = c / 255;
      return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
  }

  function terminalContrastRatio(a, b) {
    var la = terminalRelativeLuminance(a), lb = terminalRelativeLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  // Pick the xterm minimumContrastRatio floor from the composed terminal background.
  // Unparseable input defaults to the dark floor so agent output never stays invisible.
  function resolveTerminalContrastFloor(background) {
    var color = parseTerminalBackgroundRgba(background);
    if (!color) return DARK_BG_MIN_CONTRAST;
    var composited = color.a < 1
      ? {
          r: Math.round(color.r * color.a + CONTRAST_APP_SURFACE.r * (1 - color.a)),
          g: Math.round(color.g * color.a + CONTRAST_APP_SURFACE.g * (1 - color.a)),
          b: Math.round(color.b * color.a + CONTRAST_APP_SURFACE.b * (1 - color.a))
        }
      : color;
    var isLight = terminalContrastRatio({ r: 0, g: 0, b: 0 }, composited) >=
      terminalContrastRatio({ r: 255, g: 255, b: 255 }, composited);
    return isLight ? LIGHT_BG_MIN_CONTRAST : DARK_BG_MIN_CONTRAST;
  }

  function normalizeTerminalTheme(input) {
    var source = input && typeof input === 'object' && input.theme && typeof input.theme === 'object'
      ? input.theme
      : null;
    if (!source) return defaultTheme;
    var next = {};
    var keys = Object.keys(defaultTheme);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      if (typeof source[key] === 'string') next[key] = source[key];
    }
    return Object.assign({}, defaultTheme, next);
  }

  function applyTerminalTheme(input) {
    terminalThemeInput = input;
    terminalTheme = normalizeTerminalTheme(input);
    var background = terminalTheme.background || '${colors.terminalBg}';
    document.documentElement.style.background = background;
    document.body.style.background = background;
    terminalMinimumContrastRatio = resolveTerminalContrastFloor(background);
    if (term) {
      term.options.theme = terminalTheme;
      term.options.minimumContrastRatio = terminalMinimumContrastRatio;
    }
  }
`
