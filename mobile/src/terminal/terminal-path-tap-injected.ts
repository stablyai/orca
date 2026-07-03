// Plain-JS file-path-under-tap detection, injected verbatim into the terminal
// WebView's xterm script (XTERM_HTML). It is interpolated with ${...}, so the
// regex backslashes here are single (the real runtime form) — not the doubled
// form a backtick template literal would otherwise require.
//
// This mirrors the unit-tested mobile/src/terminal/terminal-path-tap.ts; keep
// the two in sync. The TS module is the source of truth for the algorithm and
// has the regression tests; this string only exists because the WebView can't
// import RN modules.
//
// Matches both slash-bearing paths AND bare filenames with an extension
// (README.md, src/index.ts:5) — like desktop, we propose candidates and let the
// host's files.resolveTerminalPath existence check reject non-files. Agents
// often print a bare filename (the markdown link target is consumed, leaving
// only the label text), so requiring a slash would miss the common case.
export const TERMINAL_PATH_TAP_JS = String.raw`
	  var FILE_PATH_RE = /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/]|(?=[A-Za-z0-9._-]*\.[A-Za-z0-9]))[A-Za-z0-9._~\-\/%+@\\()[\]]*(?::\d+)?(?::\d+)?/g;
	  var SPACED_PATH_RE = /(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/]|[A-Za-z0-9._-]+[\\/])[^()[\]{}'",;<>|\`\r\n]+(?::\d+)?(?::\d+)?/g;
	  var PATH_LEADING_TRIM = { '(': 1, '[': 1, '{': 1, '"': 1, "'": 1 };
	  var PATH_TRAILING_TRIM = { ')': 1, ']': 1, '}': 1, '"': 1, "'": 1, ',': 1, ';': 1, '.': 1 };

	  function parsePathLineCol(value) {
    var m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(value);
    if (!m) return null;
    var pathText = m[1];
    var last = pathText.charAt(pathText.length - 1);
    if (!pathText || last === '/' || last === '\\') return null;
    var line = m[2] ? parseInt(m[2], 10) : null;
    var column = m[3] ? parseInt(m[3], 10) : null;
    if ((line !== null && line < 1) || (column !== null && column < 1)) return null;
	    return { pathText: pathText, line: line, column: column };
	  }

	  function trimPathBoundaryPunctuation(raw, rawStart) {
	    var start = 0, end = raw.length;
	    while (start < end && PATH_LEADING_TRIM[raw.charAt(start)]) start += 1;
	    while (end > start && PATH_TRAILING_TRIM[raw.charAt(end - 1)]) end -= 1;
	    if (start >= end) return null;
	    return { text: raw.slice(start, end), startIndex: rawStart + start, endIndex: rawStart + end };
	  }

	  function hasSeparatorAfterWhitespace(text) {
	    var sawWhitespace = false;
	    for (var i = 0; i < text.length; i++) {
	      var ch = text.charAt(i);
	      if (/\s/.test(ch)) { sawWhitespace = true; continue; }
	      if (sawWhitespace && (ch === '/' || ch === '\\')) return true;
	    }
	    return false;
	  }

	  function trimSpacedPathTrailingProse(range, col) {
	    // A line-end extension token only extends the span when the added segment
	    // is path-like (contains a separator) — prose must not be swallowed.
	    var selected = null;
	    var extensionPrefixPattern = /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?(?=\s+|$)/g;
	    var match;
	    while ((match = extensionPrefixPattern.exec(range.text)) !== null) {
	      var end = match.index + match[0].length;
	      var text = range.text.slice(0, end);
	      if (countPathStarts(text) > 1) continue;
	      if (end < range.text.length || selected === null || /[\\/]/.test(range.text.slice(selected.length, end))) {
	        selected = text;
	      }
	    }
	    if (selected) {
	      if (col !== undefined && col >= range.startIndex + selected.length) return null;
	      return { text: selected, startIndex: range.startIndex, endIndex: range.startIndex + selected.length };
	    }
	    var text = range.text.replace(/\s+$/, '');
	    return { text: text, startIndex: range.startIndex, endIndex: range.startIndex + text.length };
	  }

	  function countPathStarts(text) {
	    var count = 0;
	    var pathStartPattern = /(?:^|\s)(?:~[\\/]|[\\/]|\.{1,2}[\\/]|[A-Za-z]:[\\/])/g;
	    while (pathStartPattern.exec(text) !== null) count += 1;
	    return count;
	  }

	  function hasSpacedPathExtension(text) {
	    var range = trimSpacedPathTrailingProse({ text: text, startIndex: 0, endIndex: text.length });
	    if (!range) return false;
	    var trimmed = range.text.replace(/\s+$/, '');
	    return /\s/.test(trimmed) && /\.[A-Za-z0-9_+-]+(?::\d+)?(?::\d+)?$/.test(trimmed);
	  }

	  function matchSpacedFilePathAtColumn(lineText, col) {
	    SPACED_PATH_RE.lastIndex = 0;
	    var match;
	    while ((match = SPACED_PATH_RE.exec(lineText)) !== null) {
	      var trimmed = trimPathBoundaryPunctuation(match[0], match.index);
	      if (!trimmed || (!hasSeparatorAfterWhitespace(trimmed.text) && !hasSpacedPathExtension(trimmed.text))) continue;
	      var candidate = trimSpacedPathTrailingProse(trimmed, col);
	      if (!candidate) continue;
	      if (col < candidate.startIndex || col >= candidate.endIndex) continue;
	      var parsed = parsePathLineCol(candidate.text);
	      if (parsed) return parsed;
	    }
	    return null;
	  }

	  function matchFilePathAtColumn(lineText, col) {
	    var spaced = matchSpacedFilePathAtColumn(lineText, col);
	    if (spaced) return spaced;
	    FILE_PATH_RE.lastIndex = 0;
    var match;
    while ((match = FILE_PATH_RE.exec(lineText)) !== null) {
      var raw = match[0];
      if (raw.length === 0) { FILE_PATH_RE.lastIndex += 1; continue; }
	      var trimmed = trimPathBoundaryPunctuation(raw, match.index);
	      if (!trimmed) continue;
	      if (col < trimmed.startIndex || col >= trimmed.endIndex) continue;
	      var parsed = parsePathLineCol(trimmed.text);
	      if (parsed) return parsed;
    }
    return null;
  }

  // Returns the path candidate under the tap, or null. Query-only so the tap
  // handler can try file detection before forwarding a mouse click — which lets
  // file paths open even inside a mouse-tracking TUI. Relies on viewportToCell/
  // getLineText from the host script scope.
  function filePathAtViewportPoint(originX, originY) {
    var tapCell = viewportToCell(originX, originY);
    if (!tapCell) return null;
    // Map the cell column to a string index so wide chars (emoji/CJK) earlier on
    // the line don't shift the match column off the tapped path.
    return matchFilePathAtColumn(
      getLineText(tapCell.row),
      cellColToStringIndex(tapCell.row, tapCell.col)
    );
  }
`
