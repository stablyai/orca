// Mouse-report coordinate mapping injected into XTERM_HTML. Closes over term,
// panX/panY, getCellWidth/Height, and getTotalScale.
export const TERMINAL_MOUSE_REPORT_CELL_JS = `
  function viewportToMouseReportCell(clientX, clientY) {
    if (!term) return null;
    var cellW = getCellWidth();
    var cellH = getCellHeight();
    if (cellW <= 0 || cellH <= 0) return null;
    if (typeof clientX !== 'number') clientX = window.innerWidth / 2;
    if (typeof clientY !== 'number') clientY = window.innerHeight / 2;
    var total = getTotalScale();
    if (total <= 0) total = 1;
    var sx = (clientX - panX) / total;
    var sy = (clientY - panY) / total;
    var maxX = Math.max(0, term.cols * cellW - 1);
    var maxY = Math.max(0, term.rows * cellH - 1);
    if (sx < 0) sx = 0;
    if (sx > maxX) sx = maxX;
    if (sy < 0) sy = 0;
    if (sy > maxY) sy = maxY;
    var col = Math.floor(sx / cellW);
    var row = Math.floor(sy / cellH);
    if (col < 0) col = 0;
    if (col > term.cols - 1) col = term.cols - 1;
    if (row < 0) row = 0;
    if (row > term.rows - 1) row = term.rows - 1;
    return { col: col, row: row, x: Math.floor(sx), y: Math.floor(sy) };
  }
`
