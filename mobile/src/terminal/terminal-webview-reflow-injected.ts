// In-WebView reflow routine, injected into XTERM_HTML. Extracted from
// terminal-webview-html.ts to keep that file within its max-lines budget.
// Closes over term / isAlternateBufferActive / applyFitScale /
// updateScrollIndicator / initRows defined in the host IIFE.
export const TERMINAL_REFLOW_JS = `
  // Why: rewrap the local xterm buffer (scrollback included) to a new width
  // after a server PTY reflow. Skip the alternate screen: those snapshots are
  // fully repainted by the PTY and a local resize there can drop SGR attributes
  // (see init's alt-screen handling), which shows as white text.
  function reflow(cols, rows) {
    if (!term || isAlternateBufferActive()) return;
    var nextCols = cols || term.cols;
    var nextRows = rows || term.rows;
    if (nextCols === term.cols && nextRows === term.rows) return;
    var buffer = term.buffer.active;
    // Why: anchor reflow on whether the user was pinned to the live bottom so
    // their scroll position survives the rewrap — if they were scrolled up,
    // hold the same distance from the bottom; if at the bottom, stay there.
    var wasAtBottom = buffer.viewportY >= buffer.baseY;
    var distanceFromBottom = buffer.baseY - buffer.viewportY;
    initRows = nextRows;
    term.resize(nextCols, nextRows);
    var rewrapped = term.buffer.active;
    if (wasAtBottom) {
      term.scrollToBottom();
    } else {
      term.scrollLines(rewrapped.baseY - distanceFromBottom - rewrapped.viewportY);
    }
    applyFitScale('reflow-msg');
    updateScrollIndicator(false);
  }
`
