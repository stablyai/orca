// Color resolution for the press-and-hold touch loupe, spliced into XTERM_HTML
// just before touch-loupe.ts (split from it to stay within the max-lines
// budget). Closes over host-IIFE functions/state: parseTerminalBackgroundRgba,
// CONTRAST_APP_SURFACE.
export const TERMINAL_HTML_TOUCH_LOUPE_COLORS = `
  var LOUPE_ANSI_KEYS = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];
  // Why: match xterm's DEFAULT_ANSI_COLORS so theme slots the theme leaves
  // untouched magnify with the colors the main renderer shows.
  var LOUPE_DEFAULT_ANSI_16 = ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf', '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'];

  // Theme css color -> opaque [r,g,b], compositing translucency over the app
  // surface exactly like the page background composes it.
  function loupeThemeRgb(cssValue, fallbackRgb) {
    var parsed = parseTerminalBackgroundRgba(cssValue);
    if (!parsed) return fallbackRgb;
    if (parsed.a < 1) {
      return [
        Math.round(parsed.r * parsed.a + CONTRAST_APP_SURFACE.r * (1 - parsed.a)),
        Math.round(parsed.g * parsed.a + CONTRAST_APP_SURFACE.g * (1 - parsed.a)),
        Math.round(parsed.b * parsed.a + CONTRAST_APP_SURFACE.b * (1 - parsed.a))
      ];
    }
    return [parsed.r, parsed.g, parsed.b];
  }

  // 256-entry palette: theme ANSI 0-15, the xterm 6x6x6 cube, 24 greys.
  function loupeBuildPalette(theme) {
    var palette = [];
    var v = [0, 0x5f, 0x87, 0xaf, 0xd7, 0xff];
    var i, c, slot;
    for (i = 0; i < 16; i++) {
      slot = loupeThemeRgb(theme[LOUPE_ANSI_KEYS[i]], null);
      palette.push(slot === null ? loupeThemeRgb(LOUPE_DEFAULT_ANSI_16[i], [0, 0, 0]) : slot);
    }
    for (i = 0; i < 216; i++) {
      palette.push([v[((i / 36) % 6) | 0], v[((i / 6) % 6) | 0], v[i % 6]]);
    }
    for (i = 0; i < 24; i++) {
      c = 8 + i * 10;
      palette.push([c, c, c]);
    }
    return palette;
  }

  // Resolve one cell's foreground/background to [r,g,b] across xterm's three
  // color modes (default / palette idx / 24-bit RGB).
  function loupeCellColor(cell, foreground, palette, theme) {
    if (foreground ? cell.isFgDefault() : cell.isBgDefault()) {
      return foreground
        ? loupeThemeRgb(theme.foreground, [192, 202, 245])
        : loupeThemeRgb(theme.background, [26, 27, 38]);
    }
    if (foreground ? cell.isFgRGB() : cell.isBgRGB()) {
      var raw = foreground ? cell.getFgColor() : cell.getBgColor();
      return [(raw >> 16) & 255, (raw >> 8) & 255, raw & 255];
    }
    var resolved = palette[foreground ? cell.getFgColor() : cell.getBgColor()];
    if (resolved) return resolved;
    return foreground ? [192, 202, 245] : [26, 27, 38];
  }
`
