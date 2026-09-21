export const TERMINAL_HTML_SELECTION_STATE_AND_EVICTION = `  // ============================================================
  // SELECTION MODE (long-press → handles → Copy)
  // ============================================================
  var WORD_RE = /[\\p{L}\\p{N}_./:@~+=?&#%-]/u;
  var LONG_PRESS_MS = 500;
  var LONG_PRESS_SLOP = 10;
  // Why: a tap that opens a link/path must survive small finger jitter. The
  // long-press slop (10px) only cancels the press-to-select timer; reusing it
  // to gate the tap dropped any URL/file tap that wandered >10px — at fit scale
  // a few screen px of jitter is a normal tap. Use a wider, time-bounded tap
  // window so deliberate scrolls/pans still don't fire a tap.
  var TAP_SLOP = 24;
  var TAP_MAX_MS = 700;
  var EDGE_SCROLL_PX = 40;
  var EDGE_SCROLL_INTERVAL = 60;

  var selectionOverlay = document.getElementById('selection-overlay');
  var handleStart = document.getElementById('sel-handle-start');
  var handleEnd = document.getElementById('sel-handle-end');
  var selMenu = document.getElementById('sel-menu');
  var btnCopy = document.getElementById('sel-menu-copy');
  var btnSelAll = document.getElementById('sel-menu-all');

  // mode: 'navigate' | 'select'
  var selMode = 'navigate';
  var sel = null; // { anchor:{col,row}, focus:{col,row}, activeHandle:null|'start'|'end' }
  var longPressTimer = null;
  var longPressOrigin = null; // {x,y, identifier}
  // Why: tap detection is tracked separately from the long-press timer so a
  // small jitter that cancels the press-to-select timer does not also cancel
  // the tap (which opens links/paths). {x,y,t,identifier} or null once the
  // gesture is disqualified as a tap (moved too far or held too long).
  var tapCandidate = null;
  var edgeScrollTimer = null;
  var edgeScrollDir = 0;
  var edgeScrollClientX = 0;
  var edgeScrollClientY = 0;

  // Eviction watchdog: linesEverWritten counts onLineFeed since last init.
  // Once buffer is full, every onLineFeed evicts the top row in xterm and
  // we mirror that by decrementing stored absolute rows.
  var linesEverWritten = 0;

  function resetEvictionCounter() { linesEverWritten = 0; }

  function isBufferFull() {
    if (!term) return false;
    return linesEverWritten >= 5000 + (term.rows || 0);
  }

  function checkEviction() {
    if (selMode !== 'select' || !sel) return;
    var oldest = Math.min(sel.anchor.row, sel.focus.row);
    if (oldest < 0) {
      notify({ type: 'selection-evicted' });
      cancelSelect();
    }
  }

  function logFeedAndEvict() {
    linesEverWritten++;
    if (initialOscLinkEvictionReady && isBufferFull()) initialOscLinkRowOffset += 1;
    if (selMode === 'select' && sel && isBufferFull()) {
      sel.anchor.row -= 1;
      sel.focus.row -= 1;
      checkEviction();
      repositionOverlay();
    }
  }

`
