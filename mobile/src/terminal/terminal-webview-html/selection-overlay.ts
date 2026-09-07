import { TERMINAL_PATH_TAP_JS } from '../terminal-path-tap-injected'
import { URL_TAP_WEBVIEW_JS } from '../terminal-webview-url-tap'

// Opens with the path/url tap matchers: they land at this point in the emitted document.
export const TERMINAL_HTML_SELECTION_OVERLAY = `  ${TERMINAL_PATH_TAP_JS}
  ${URL_TAP_WEBVIEW_JS}

  function seedWordSelection(col, absRow) {
    var line = getLineText(absRow);
    if (!line) {
      sel = { anchor: { col: col, row: absRow }, focus: { col: col, row: absRow }, activeHandle: null };
      applyXtermSelection();
      return;
    }
    var s = col;
    var e = col;
    if (col >= 0 && col < line.length && WORD_RE.test(line[col])) {
      while (s > 0 && WORD_RE.test(line[s - 1])) s--;
      while (e < line.length - 1 && WORD_RE.test(line[e + 1])) e++;
    }
    sel = {
      anchor: { col: s, row: absRow },
      focus: { col: e, row: absRow },
      activeHandle: null
    };
    applyXtermSelection();
  }

  function isStartFirst(a, b) {
    if (a.row !== b.row) return a.row < b.row;
    return a.col <= b.col;
  }

  function selRange() {
    if (!sel) return null;
    if (isStartFirst(sel.anchor, sel.focus)) return { start: sel.anchor, end: sel.focus };
    return { start: sel.focus, end: sel.anchor };
  }

  function applyXtermSelection() {
    if (!term || !sel) return;
    var r = selRange();
    if (!r) return;
    // Why: term.select(col, row, length) takes a buffer-absolute row,
    // not a viewport-relative one. Subtracting viewportY here drifts the
    // selection by the scrollback height — handles render where the user
    // pressed (their math is independent), but xterm highlights an
    // off-screen scrollback region and copies the wrong text.
    var length;
    if (r.start.row === r.end.row) {
      length = Math.max(1, r.end.col - r.start.col + 1);
    } else {
      var first = term.cols - r.start.col;
      var middle = Math.max(0, r.end.row - r.start.row - 1) * term.cols;
      var last = r.end.col + 1;
      length = first + middle + last;
    }
    try { term.select(r.start.col, r.start.row, length); } catch (e) {}
  }

  function cancelSelect() {
    selMode = 'navigate';
    sel = null;
    stopEdgeScroll();
    if (term) {
      try { term.clearSelection(); } catch (e) {}
      // Why: some xterm renderers cache cells and skip repaint on
      // clearSelection alone, leaving the previously-highlighted cells
      // visually selected. Force a full refresh so the selection layer
      // actually clears on screen.
      try { term.refresh(0, term.rows - 1); } catch (e) {}
    }
    selectionOverlay.classList.remove('active');
    notify({ type: 'set-select-mode', enabled: false });
  }

  function enterSelect(col, absRow) {
    selMode = 'select';
    seedWordSelection(col, absRow);
    selectionOverlay.classList.add('active');
    notify({ type: 'set-select-mode', enabled: true });
    notify({ type: 'haptic', kind: 'selection' });
    repositionOverlay();
  }

  function repositionOverlay() {
    if (selMode !== 'select' || !sel || !term) return;
    var r = selRange();
    var sPx = cellToViewportPx(r.start.col, r.start.row);
    var ePx = cellToViewportPx(r.end.col + 1, r.end.row);
    var cellH = getCellHeight() * getTotalScale();
    // Why: native iOS pattern — start handle anchors at the TOP of the
    // first selected cell (dot above, stem covers the cell going down);
    // end handle anchors at the BOTTOM of the last selected cell (dot
    // below, stem covers the cell going up).
    handleStart.style.left = sPx.x + 'px';
    handleStart.style.top = sPx.y + 'px';
    handleEnd.style.left = ePx.x + 'px';
    handleEnd.style.top = (ePx.y + cellH) + 'px';
    var startVisible = sPx.y >= 0 && sPx.y <= window.innerHeight;
    var endVisible = ePx.y >= 0 && ePx.y <= window.innerHeight;
    handleStart.style.visibility = startVisible ? 'visible' : 'hidden';
    handleEnd.style.visibility = endVisible ? 'visible' : 'hidden';
    var menuCenterX, menuY, vTransform, marginTop;
    if (startVisible && sPx.y > 56) {
      menuCenterX = sPx.x; menuY = sPx.y;
      vTransform = 'translateY(-100%)';
      marginTop = '-12px';
    } else if (endVisible && ePx.y + cellH + 56 < window.innerHeight) {
      menuCenterX = ePx.x; menuY = ePx.y + cellH;
      vTransform = 'translateY(0)';
      marginTop = '12px';
    } else {
      // selection covers full viewport — pin to visible center
      menuCenterX = window.innerWidth / 2;
      menuY = window.innerHeight / 2;
      vTransform = 'translateY(-50%)';
      marginTop = '0';
    }
    // Why: clamp horizontally so the pill stays fully visible when the
    // selection sits near a screen edge. We position via plain left
    // (no horizontal translate) so the clamp math is straightforward.
    selMenu.style.transform = vTransform;
    selMenu.style.marginTop = marginTop;
    selMenu.style.top = menuY + 'px';
    selMenu.style.left = '0px';
    var EDGE_MARGIN = 8;
    var menuW = selMenu.offsetWidth || 0;
    var minLeft = EDGE_MARGIN;
    var maxLeft = Math.max(EDGE_MARGIN, window.innerWidth - menuW - EDGE_MARGIN);
    var desiredLeft = menuCenterX - menuW / 2;
    var clampedLeft = Math.max(minLeft, Math.min(maxLeft, desiredLeft));
    selMenu.style.left = clampedLeft + 'px';
  }

  function syncSelectionHandleToViewportPoint(handle, clientX, clientY) {
    var c = viewportToCell(clientX, clientY);
    if (!c || !sel) return false;
    if (handle === 'start') sel.anchor = c;
    else sel.focus = c;
    applyXtermSelection();
    return true;
  }

  function syncEdgeScrollSelectionEndpoint() {
    if (!sel || !sel.activeHandle) return false;
    // Why: WebView may not emit new touchmove events while a handle is held
    // at the edge; resample the stored finger point after each viewport scroll.
    return syncSelectionHandleToViewportPoint(
      sel.activeHandle,
      edgeScrollClientX,
      edgeScrollClientY
    );
  }

  function startEdgeScroll(dir) {
    if (edgeScrollDir === dir) return;
    stopEdgeScroll();
    edgeScrollDir = dir;
    edgeScrollTimer = setInterval(function() {
      if (!term || edgeScrollDir === 0) return;
      var beforeY = term.buffer.active.viewportY;
      term.scrollLines(edgeScrollDir);
      var afterY = term.buffer.active.viewportY;
      if (beforeY === afterY) {
        notify({ type: 'haptic', kind: 'edge-bump' });
        stopEdgeScroll();
        return;
      }
      syncEdgeScrollSelectionEndpoint();
      repositionOverlay();
    }, EDGE_SCROLL_INTERVAL);
  }

  function stopEdgeScroll() {
    if (edgeScrollTimer) {
      clearInterval(edgeScrollTimer);
      edgeScrollTimer = null;
    }
    edgeScrollDir = 0;
  }

  function handleDragMove(handle, clientX, clientY) {
    edgeScrollClientX = clientX;
    edgeScrollClientY = clientY;
    if (!syncSelectionHandleToViewportPoint(handle, clientX, clientY)) return;
    repositionOverlay();
    if (clientY < EDGE_SCROLL_PX) startEdgeScroll(-1);
    else if (clientY > window.innerHeight - EDGE_SCROLL_PX) startEdgeScroll(1);
    else stopEdgeScroll();
  }

  // Latching document-level touch dispatcher: see
  // terminal-webview-tap-dispatch-injected.ts (extracted for max-lines).
`
