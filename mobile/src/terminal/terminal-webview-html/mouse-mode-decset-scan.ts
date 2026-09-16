export const TERMINAL_HTML_MOUSE_MODE_DECSET_SCAN = `  function isAltScreenActive(data) {
    if (typeof data !== 'string') return false;
    var on = data.lastIndexOf(ESC + '[?1049h');
    var off = data.lastIndexOf(ESC + '[?1049l');
    return on !== -1 && on > off;
  }

  function normalizeInitialData(data) {
    if (!isAltScreenActive(data)) return data;
    var on = data.lastIndexOf(ESC + '[?1049h');
    // Why: SerializeAddon can include normal-buffer scrollback before the
    // active alternate-screen snapshot. Replaying both into a fresh mobile
    // xterm duplicates TUI frames and can flatten SGR attributes.
    return on > 0 ? data.slice(on) : data;
  }

  function updateMouseModeFromData(data) {
    if (typeof data !== 'string' || data.length === 0) return;
    var input = mouseModeScanTail + data;
    mouseModeScanTail = extractMouseModeScanTail(input);
    var re = new RegExp(ESC + 'c|' + ESC + '\\\\[\\\\?([0-9;]+)([hl])|' + C1_CSI + '\\\\?([0-9;]+)([hl])', 'g');
    var match;
    while ((match = re.exec(input)) !== null) {
      if (match[0] === ESC + 'c') {
        trackedMouseTrackingMode = 'none';
        sgrMouseMode = false;
        sgrMousePixelsMode = false;
        continue;
      }
      var enabled = (match[2] || match[4]) === 'h';
      var params = (match[1] || match[3]).split(';');
      for (var i = 0; i < params.length; i++) {
        if (params[i] === '') continue;
        var param = Number(params[i]);
        if (!Number.isInteger(param)) continue;
        if (param === 9) trackedMouseTrackingMode = enabled ? 'x10' : 'none';
        if (param === 1000) trackedMouseTrackingMode = enabled ? 'vt200' : 'none';
        if (param === 1002) trackedMouseTrackingMode = enabled ? 'drag' : 'none';
        if (param === 1003) trackedMouseTrackingMode = enabled ? 'any' : 'none';
        if (param === 1006) {
          sgrMouseMode = enabled;
          sgrMousePixelsMode = false;
        }
        if (param === 1016) {
          sgrMouseMode = false;
          sgrMousePixelsMode = enabled;
        }
      }
    }
  }

`
