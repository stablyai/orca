// In-WebView reflow routine, injected into XTERM_HTML. Extracted from
// terminal-webview-html.ts to keep that file within its max-lines budget.
// Closes over term / isAlternateBufferActive / scrollCoordinator /
// terminalGeneration defined in the host IIFE.
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
    scrollCoordinator.dispatch({
      type: 'viewport-change',
      generation: terminalGeneration,
      change: { cols: nextCols, rows: nextRows, reason: 'reflow' }
    });
    scrollCoordinator.dispatch({ type: 'viewport-committed', generation: terminalGeneration });
  }
`
