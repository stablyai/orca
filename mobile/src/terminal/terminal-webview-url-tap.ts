export const TERMINAL_HTTP_URL_REGEX_SOURCE =
  String.raw`\bhttps?:\/\/[^\s"'!*(){}|\\^<>` +
  '`' +
  String.raw`]*[^\s"':,.!?{}|\\^~[\]` +
  '`' +
  String.raw`()<>]`

export function findUrlAtColumn(lineText: string, col: number): string | null {
  if (typeof lineText !== 'string' || lineText.length === 0) {
    return null
  }
  const re = new RegExp(TERMINAL_HTTP_URL_REGEX_SOURCE, 'gi')
  let match: RegExpExecArray | null
  while ((match = re.exec(lineText)) !== null) {
    const start = match.index
    const end = start + match[0].length
    if (col >= start && col < end) {
      return match[0]
    }
    // Why: protect the injected loop if the regex ever changes to allow empties.
    if (match[0].length === 0) {
      re.lastIndex++
    }
  }
  return null
}

export const URL_TAP_WEBVIEW_JS = `
  var URL_TAP_RE_SOURCE = ${JSON.stringify(TERMINAL_HTTP_URL_REGEX_SOURCE)};
  function findUrlAtColumn(lineText, col) {
    if (typeof lineText !== 'string' || lineText.length === 0) return null;
    var re = new RegExp(URL_TAP_RE_SOURCE, 'gi');
    var match;
    while ((match = re.exec(lineText)) !== null) {
      var end = match.index + match[0].length;
      if (col >= match.index && col < end) return match[0];
      if (match[0].length === 0) re.lastIndex++;
    }
    return null;
  }
  function urlAtViewportPoint(clientX, clientY) {
    var cell = viewportToCell(clientX, clientY);
    if (!cell) return null;
    // Map the cell column to a string index so wide chars earlier on the line
    // don't shift the match column off the tapped URL.
    return findUrlAtColumn(getLineText(cell.row), cellColToStringIndex(cell.row, cell.col));
  }

  // Why: OSC 8 links can render as labels like "#1234"; the URI lives in
  // xterm's internal link service, so every access is guarded and falls through.
  function oscLinkService() {
    try {
      var core = term && term._core;
      if (!core) return null;
      return core._oscLinkService
        || (core._inputHandler && core._inputHandler._oscLinkService)
        || null;
    } catch (e) { return null; }
  }
  function oscLinkAtViewportPoint(clientX, clientY) {
    try {
      var svc = oscLinkService();
      if (!svc || !svc.getLinkData) return null;
      var cell = viewportToCell(clientX, clientY);
      if (!cell) return null;
      var line = term.buffer.active.getLine(cell.row);
      if (!line) return null;
      var bufCell = line.getCell(cell.col);
      var urlId = bufCell && bufCell.extended && bufCell.extended.urlId;
      if (!urlId) return null;
      var data = svc.getLinkData(urlId);
      var uri = data && data.uri;
      return uri && /^https?:/i.test(uri) ? uri : null;
    } catch (e) { return null; }
  }

  function notifyTerminalSurfaceTap(originX, originY) {
    var tappedUrl = oscLinkAtViewportPoint(originX, originY) || urlAtViewportPoint(originX, originY);
    if (tappedUrl) {
      notify({ type: 'open-url', url: tappedUrl });
      return;
    }
    var tappedPath = filePathAtViewportPoint(originX, originY);
    if (tappedPath) {
      notify({
        type: 'terminal-file-tap',
        pathText: tappedPath.pathText,
        line: tappedPath.line,
        column: tappedPath.column
      });
      return;
    }
    var clickInput = buildMouseClickInput(originX, originY);
    if (clickInput) {
      notify({ type: 'terminal-input', bytes: clickInput });
    } else if (!isClickMouseTrackingMode(getMouseTrackingMode())) {
      notify({ type: 'terminal-tap' });
    }
  }
`
