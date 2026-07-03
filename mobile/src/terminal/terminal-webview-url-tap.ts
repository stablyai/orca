export { resolveTerminalFileUrlTap, resolveTerminalOscFileTap } from './terminal-file-url-tap'

export const TERMINAL_HTTP_URL_REGEX_SOURCE =
  String.raw`\bhttps?:\/\/[^\s"'!*(){}|\\^<>` +
  '`' +
  String.raw`]*[^\s"':,.!?{}|\\^~[\]` +
  '`' +
  String.raw`()<>]`
export const TERMINAL_FILE_URL_REGEX_SOURCE =
  String.raw`\bfile:\/\/[^\s"'!*(){}|\\^<>` +
  '`' +
  String.raw`]*[^\s"',!?{}|\\^~[\]` +
  '`' +
  String.raw`()<>]`
export const TERMINAL_HTTP_URL_MAX_LENGTH = 2048

export function findUrlAtColumn(lineText: string, col: number): string | null {
  return findTerminalUrlAtColumn(lineText, col, TERMINAL_HTTP_URL_REGEX_SOURCE)
}

export function findFileUrlAtColumn(lineText: string, col: number): string | null {
  return findTerminalUrlAtColumn(lineText, col, TERMINAL_FILE_URL_REGEX_SOURCE)
}

function findTerminalUrlAtColumn(lineText: string, col: number, source: string): string | null {
  if (typeof lineText !== 'string' || lineText.length === 0) {
    return null
  }
  const re = new RegExp(source, 'gi')
  let match: RegExpExecArray | null
  while ((match = re.exec(lineText)) !== null) {
    const start = match.index
    const end = start + match[0].length
    // Why: desktop rejects overlong terminal URL candidates before opening;
    // mobile taps should preserve the same safety bound.
    if (match[0].length <= TERMINAL_HTTP_URL_MAX_LENGTH && col >= start && col < end) {
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
  var FILE_URL_TAP_RE_SOURCE = ${JSON.stringify(TERMINAL_FILE_URL_REGEX_SOURCE)};
  var URL_TAP_MAX_LENGTH = ${TERMINAL_HTTP_URL_MAX_LENGTH};
  function findUrlAtColumn(lineText, col) {
    return findTerminalUrlAtColumn(lineText, col, URL_TAP_RE_SOURCE);
  }
  function findFileUrlAtColumn(lineText, col) {
    return findTerminalUrlAtColumn(lineText, col, FILE_URL_TAP_RE_SOURCE);
  }
  function findTerminalUrlAtColumn(lineText, col, source) {
    if (typeof lineText !== 'string' || lineText.length === 0) return null;
    var re = new RegExp(source, 'gi');
    var match;
    while ((match = re.exec(lineText)) !== null) {
      var end = match.index + match[0].length;
      if (match[0].length <= URL_TAP_MAX_LENGTH && col >= match.index && col < end) return match[0];
      if (match[0].length === 0) re.lastIndex++;
    }
    return null;
  }
  function fileUrlAtViewportPoint(clientX, clientY) {
    var cell = viewportToCell(clientX, clientY);
    if (!cell) return null;
    return findFileUrlAtColumn(getLineText(cell.row), cellColToStringIndex(cell.row, cell.col));
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
      var cell = viewportToCell(clientX, clientY);
      if (!cell) return null;
      var line = term.buffer.active.getLine(cell.row);
      if (!line) return null;
      var urlId = oscLinkIdAtCell(line, cell.col);
      if (!urlId) return initialOscLinkAtCell(cell.row, cell.col);
      var svc = oscLinkService();
      if (!svc || !svc.getLinkData) return initialOscLinkAtCell(cell.row, cell.col);
      var data = svc.getLinkData(urlId);
      var uri = data && data.uri;
      return terminalOscLinkTarget(uri);
    } catch (e) { return null; }
  }
  function initialOscLinkAtCell(row, col) {
    for (var i = 0; i < initialOscLinks.length; i++) {
      var link = initialOscLinks[i];
      if (!link || typeof link.uri !== 'string') continue;
      if (link.row < initialOscLinkRowOffset) continue;
      var shiftedRow = link.row - initialOscLinkRowOffset;
      if (shiftedRow === row && col >= link.startCol && col < link.endCol && initialOscLinkTextStillMatches(link, shiftedRow)) return terminalOscLinkTarget(link.uri);
    }
    return null;
  }
  function terminalOscLinkTarget(uri) {
    if (typeof uri !== 'string') return null;
    if (/^https?:/i.test(uri)) return { kind: 'url', url: uri };
    var fileTap = resolveTerminalOscFileTap(uri);
    return fileTap ? { kind: 'file', fileTap: fileTap } : null;
  }
  function resolveTerminalOscFileTap(uri) {
    return resolveTerminalFileUrlTap(uri) || parseOscPathLikeTarget(uri);
  }
  function resolveTerminalFileUrlTap(uri) {
    var parsed;
    try {
      parsed = new URL(uri);
    } catch (e) {
      return null;
    }
    if (parsed.protocol !== 'file:') return null;
    var filePath;
    try {
      filePath = decodeURIComponent(parsed.pathname || '');
    } catch (e) {
      return null;
    }
    if (parsed.hostname && !isLocalFileUriHostname(parsed.hostname)) {
      filePath = '//' + parsed.hostname + filePath;
    } else if (/^\\/[A-Za-z]:\\//.test(filePath)) {
      filePath = filePath.slice(1);
    }
    if (!filePath) return null;
    var hashTarget = parseFileUrlLineHash(parsed.hash || '');
    if (hashTarget) {
      return { pathText: filePath, line: hashTarget.line, column: hashTarget.column };
    }
    if (/%3a/i.test(parsed.pathname || '')) {
      return { pathText: filePath, line: null, column: null };
    }
    return parseFilePathTrailingLineTarget(filePath) || { pathText: filePath, line: null, column: null };
  }
  function isLocalFileUriHostname(hostname) {
    var normalized = String(hostname).toLowerCase();
    return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1' || normalized === '[::1]';
  }
	  function parseOscPathLikeTarget(value) {
	    if (!/^(?:~[\\\\/]|[\\\\/]|\\.{1,2}[\\\\/]|[A-Za-z]:[\\\\/]|[A-Za-z0-9._-]+[\\\\/]|(?=[A-Za-z0-9._-]*\\.[A-Za-z0-9]))/.test(value)) return null;
	    return parsePathLineCol(value);
	  }
  function parseFileUrlLineHash(hash) {
    var match = /^#?L(\\d+)(?:C(\\d+))?$/i.exec(hash);
    if (!match) return null;
    var line = parseInt(match[1], 10);
    var column = match[2] ? parseInt(match[2], 10) : null;
    if (line < 1 || (column !== null && column < 1)) return null;
    return { line: line, column: column };
  }
  function parseFilePathTrailingLineTarget(filePath) {
    var match = /^(.*?)(?::(\\d+))(?::(\\d+))?$/.exec(filePath);
    if (!match || !match[1] || match[1].charAt(match[1].length - 1) === '/' || match[1].charAt(match[1].length - 1) === '\\\\') return null;
    var line = parseInt(match[2], 10);
    var column = match[3] ? parseInt(match[3], 10) : null;
    if (line < 1 || (column !== null && column < 1)) return null;
    return { pathText: match[1], line: line, column: column };
  }
  function captureInitialOscLinkTexts() {
    if (!Array.isArray(initialOscLinks)) return;
    for (var i = 0; i < initialOscLinks.length; i++) {
      var link = initialOscLinks[i];
      if (!link || typeof link.text === 'string') continue;
      link.text = initialOscLinkTextAtRow(link, link.row);
    }
  }
  function initialOscLinkTextStillMatches(link, row) {
    if (typeof link.text !== 'string') return false;
    return link.text.length > 0 && initialOscLinkTextAtRow(link, row) === link.text;
  }
  function initialOscLinkTextAtRow(link, row) {
    try {
      var lineText = getLineText(row);
      var start = cellColToStringIndex(row, link.startCol);
      var end = cellColToStringIndex(row, link.endCol);
      return lineText.slice(start, end);
    } catch (e) {
      return '';
    }
  }
  function oscLinkIdAtCell(line, col) {
    try {
      var bufCell = line.getCell(col);
      return bufCell && bufCell.extended && bufCell.extended.urlId ? bufCell.extended.urlId : 0;
    } catch (e) { return 0; }
  }

  function notifyTerminalSurfaceTap(originX, originY) {
    var tappedOscLink = oscLinkAtViewportPoint(originX, originY);
    if (tappedOscLink && tappedOscLink.kind === 'file') {
      notify({
        type: 'terminal-file-tap',
        pathText: tappedOscLink.fileTap.pathText,
        line: tappedOscLink.fileTap.line,
        column: tappedOscLink.fileTap.column
      });
      return;
    }
    var tappedFileUrl = fileUrlAtViewportPoint(originX, originY);
    var tappedFileUrlPath = tappedFileUrl ? resolveTerminalFileUrlTap(tappedFileUrl) : null;
    if (tappedFileUrlPath) {
      notify({
        type: 'terminal-file-tap',
        pathText: tappedFileUrlPath.pathText,
        line: tappedFileUrlPath.line,
        column: tappedFileUrlPath.column
      });
      return;
    }
    var tappedUrl = tappedOscLink && tappedOscLink.kind === 'url' ? tappedOscLink.url : urlAtViewportPoint(originX, originY);
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
