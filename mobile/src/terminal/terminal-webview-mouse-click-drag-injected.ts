// Indirect-pointer (external mouse / trackpad) click and drag for the terminal
// surface, injected into XTERM_HTML. Extracted from terminal-webview-html.ts to
// keep that file within its max-lines budget. Companion to
// terminal-webview-wheel-scroll-injected.ts, which owns the wheel half (#11247);
// this owns the click/drag half of #8818, plus the right-button/double-click
// selection overrides (the mobile analog of desktop Shift+drag). Closes over
// host-IIFE state/functions: term, ESC, sel, selMode, selectionOverlay,
// TAP_SLOP, getMouseTrackingMode, viewportToCell, viewportToMouseReportCell,
// isSafeSgrMouseCoordinate, sgrMouseMode, sgrMousePixelsMode, notify,
// notifyTerminalSurfaceTap, cancelSelect, enterSelect, applyXtermSelection,
// repositionOverlay, handleDragMove, stopEdgeScroll, and
// dispatcherShouldBlockSurface.
//
// Why pointer events: a hardware mouse on Android/iPadOS raises pointer events
// with pointerType 'mouse' and NO touch events, while a finger raises
// pointerType 'touch' plus the touch events the document dispatcher owns. The
// capture-phase mousedown/click suppression in attachSurfaceEventHandlers stays:
// it is what keeps xterm's own mouse handling inert (its onData output is
// dropped by the mobile bridge), and pointer events are unaffected by it.
export const TERMINAL_MOUSE_CLICK_DRAG_JS = `
  var mouseGesture = null;

  // Why: touch taps raise the soft keyboard via the terminal-tap notify, but a
  // mouse click historically could not (protecting iPad + hardware keyboard,
  // #12772). Rule: raise it on Android only — iPadOS never matches an Android
  // UA. There is no WebView-visible hardware-keyboard probe (navigator.keyboard
  // is SecureContext-gated and this document loads without a baseUrl, so it is
  // undefined on every Android device), so whether the soft IME actually opens
  // over a hardware keyboard is the OS's call — Android keeps it closed while
  // it sees one active, and focus lands either way, so keystrokes flow.
  function shouldMouseTapFocusKeyboard() {
    return /Android/i.test(navigator.userAgent);
  }

  var DOUBLE_CLICK_MS = 350;
  var DOUBLE_CLICK_SLOP = 24;
  var lastLeftClick = null; // {x, y, t} of the last dispatched left tap

  // One report per transition, built with the same encoding ladder as
  // buildMouseClickInput: SGR pixels (1016) > SGR (1006) > default. Returns ''
  // when the mode does not report this transition (x10 has no release, only
  // drag/any report motion) or the cell is not encodable.
  function buildMouseButtonReport(kind, clientX, clientY) {
    var mouseTrackingMode = getMouseTrackingMode();
    if (mouseTrackingMode === 'none') return '';
    if (kind === 'motion' && mouseTrackingMode !== 'drag' && mouseTrackingMode !== 'any') return '';
    if (kind === 'release' && mouseTrackingMode === 'x10') return '';
    var cell = viewportToMouseReportCell(clientX, clientY);
    if (!cell) return '';
    var sgrButton = kind === 'motion' ? 32 : 0;
    var sgrFinal = kind === 'release' ? 'm' : 'M';
    if (sgrMousePixelsMode) {
      if (!isSafeSgrMouseCoordinate(cell.x) || !isSafeSgrMouseCoordinate(cell.y)) return '';
      return ESC + '[<' + sgrButton + ';' + cell.x + ';' + cell.y + sgrFinal;
    }
    if (sgrMouseMode) {
      // Why: xterm increments zero-based mouse cells before encoding reports.
      var sgrCol = cell.col + 1;
      var sgrRow = cell.row + 1;
      if (!isSafeSgrMouseCoordinate(sgrCol) || !isSafeSgrMouseCoordinate(sgrRow)) return '';
      return ESC + '[<' + sgrButton + ';' + sgrCol + ';' + sgrRow + sgrFinal;
    }
    var button = kind === 'motion' ? 64 : kind === 'release' ? 35 : 32;
    var col = cell.col + 1 + 32;
    var row = cell.row + 1 + 32;
    // Why: non-SGR mouse bytes above ASCII are not preserved reliably through
    // the mobile JSON/RPC string path; drop instead of corrupting input.
    if (col > 126 || row > 126) return '';
    return ESC + '[M' + String.fromCharCode(button) + String.fromCharCode(col) + String.fromCharCode(row);
  }

  function mouseReportCellKey(clientX, clientY) {
    var cell = viewportToMouseReportCell(clientX, clientY);
    return cell ? cell.col + ',' + cell.row : null;
  }

  function abandonMouseGesture() {
    var gesture = mouseGesture;
    mouseGesture = null;
    if (!gesture) return;
    // Why: a cancelled left gesture was never a dispatched tap, so it must not
    // pair with a later tap into a double click.
    if (gesture.button === 0) lastLeftClick = null;
    if (gesture.mode === 'tracking') {
      // Why: the press report already went to the TUI; a lost pointer must not
      // leave the button latched down on the far side.
      var release = buildMouseButtonReport('release', gesture.lastX, gesture.lastY);
      if (release) notify({ type: 'terminal-input', bytes: release });
    } else if (gesture.mode === 'selecting') {
      if (sel) sel.activeHandle = null;
      stopEdgeScroll();
    }
  }

  function beginMouseDrag(gesture) {
    gesture.moved = true;
    // Why: once a left gesture becomes a drag it is no longer a tap; leaving the
    // prior tap armed would let drag-then-tap masquerade as a double click (and
    // eat the user's next genuine one).
    if (gesture.button === 0) lastLeftClick = null;
    // Why: the right button is the selection override — desktop terminals offer
    // Shift+drag to select over a mouse-tracking TUI, but touch hardware has no
    // Shift; the right button is always available and never reported to the TUI.
    if (gesture.button !== 2 && getMouseTrackingMode() !== 'none') {
      gesture.mode = 'tracking';
      gesture.lastCellKey = mouseReportCellKey(gesture.startX, gesture.startY);
      var press = buildMouseButtonReport('press', gesture.startX, gesture.startY);
      if (press) notify({ type: 'terminal-input', bytes: press });
      return;
    }
    var anchor = viewportToCell(gesture.startX, gesture.startY);
    if (!anchor) {
      gesture.mode = 'cancelled';
      return;
    }
    // Why: mouse drags select character-anchored ranges like desktop terminals,
    // not the word-seeded long-press selection; reuse the touch handle-drag
    // plumbing (edge scroll included) by acting as a live 'end' handle.
    gesture.mode = 'selecting';
    selMode = 'select';
    sel = { anchor: anchor, focus: anchor, activeHandle: 'end' };
    selectionOverlay.classList.add('active');
    notify({ type: 'set-select-mode', enabled: true });
    applyXtermSelection();
    repositionOverlay();
  }

  function attachSurfaceMouseClickDragHandler(targetSurface) {
    targetSurface.addEventListener('pointerdown', function(e) {
      if (e.pointerType !== 'mouse' || (e.button !== 0 && e.button !== 2)) return;
      if (dispatcherShouldBlockSurface() || !term) return;
      // Why: a pointerup lost outside the WebView must not leave the previous
      // gesture latched (tracking press with no release) when the next one lands.
      if (mouseGesture) abandonMouseGesture();
      // Why: mouse pointers have no implicit capture; without it a drag that
      // leaves the surface drops pointermove/pointerup and strands the gesture.
      try {
        if (targetSurface.setPointerCapture) targetSurface.setPointerCapture(e.pointerId);
      } catch (err) {}
      mouseGesture = {
        startX: e.clientX, startY: e.clientY,
        lastX: e.clientX, lastY: e.clientY,
        lastCellKey: null,
        button: e.button,
        moved: false,
        mode: 'pending',
        dismissedSelection: false
      };
      if (selMode === 'select') {
        // Why: touch parity — pressing outside the pill dismisses the current
        // selection; the same press may still start a new drag selection.
        cancelSelect();
        mouseGesture.dismissedSelection = true;
      }
    }, true);

    targetSurface.addEventListener('pointermove', function(e) {
      var gesture = mouseGesture;
      if (e.pointerType !== 'mouse' || !gesture || gesture.mode === 'cancelled') return;
      if (!term) return;
      gesture.lastX = e.clientX;
      gesture.lastY = e.clientY;
      var buttonMask = gesture.button === 2 ? 2 : 1;
      if ((e.buttons & buttonMask) === 0) {
        // Why: a pointerup lost outside the WebView (capture unavailable) must
        // end the gesture here, or a tracked press stays latched at the TUI.
        // Coordinates first, so the synthesized release lands where the
        // pointer re-entered rather than at the previous cell.
        abandonMouseGesture();
        return;
      }
      if (!gesture.moved) {
        var dx = Math.abs(e.clientX - gesture.startX);
        var dy = Math.abs(e.clientY - gesture.startY);
        if (dx + dy <= TAP_SLOP) return;
        beginMouseDrag(gesture);
      }
      if (gesture.mode === 'tracking') {
        // Why: one motion report per cell keeps drags bounded by grid size, not
        // by pointermove cadence, so the RN rate limiter is never the bottleneck.
        var cellKey = mouseReportCellKey(e.clientX, e.clientY);
        if (cellKey && cellKey !== gesture.lastCellKey) {
          gesture.lastCellKey = cellKey;
          var motion = buildMouseButtonReport('motion', e.clientX, e.clientY);
          if (motion) notify({ type: 'terminal-input', bytes: motion });
        }
      } else if (gesture.mode === 'selecting') {
        handleDragMove('end', e.clientX, e.clientY);
      }
    }, true);

    targetSurface.addEventListener('pointerup', function(e) {
      var gesture = mouseGesture;
      if (e.pointerType !== 'mouse' || !gesture || e.button !== gesture.button) return;
      mouseGesture = null;
      if (gesture.mode === 'cancelled' || !term) return;
      if (gesture.mode === 'tracking') {
        var release = buildMouseButtonReport('release', e.clientX, e.clientY);
        if (release) notify({ type: 'terminal-input', bytes: release });
        return;
      }
      if (gesture.mode === 'selecting') {
        if (sel) sel.activeHandle = null;
        stopEdgeScroll();
        repositionOverlay();
        return;
      }
      if (dispatcherShouldBlockSurface()) return;
      if (gesture.button === 2) {
        // Right click without a drag: word-select where the pointer sits, the
        // mouse analog of the touch long-press. Runs past the dismiss guard on
        // purpose — replacing a selection is exactly what a re-select means.
        var cell = viewportToCell(e.clientX, e.clientY);
        if (cell) enterSelect(cell.col, cell.row);
        return;
      }
      var now = Date.now();
      // Why: record the tap before the dismiss guard so a dismissing click
      // still anchors a double click — dismiss-then-double-click must reselect.
      var doubleTap = lastLeftClick
        && (now - lastLeftClick.t) <= DOUBLE_CLICK_MS
        && (Math.abs(e.clientX - lastLeftClick.x) + Math.abs(e.clientY - lastLeftClick.y)) <= DOUBLE_CLICK_SLOP;
      lastLeftClick = doubleTap ? null : { x: e.clientX, y: e.clientY, t: now };
      // Why: a dismissing tap only clears the selection (touch parity); it must
      // not also open a link or focus the keyboard underneath.
      if (gesture.dismissedSelection) return;
      if (doubleTap && getMouseTrackingMode() === 'none') {
        // Why: only in 'none' — a TUI consuming clicks owns its double-click
        // semantics, and both of its clicks were already reported above.
        var tapCell = viewportToCell(e.clientX, e.clientY);
        if (tapCell) enterSelect(tapCell.col, tapCell.row);
        return;
      }
      // Pointer clicks keep their current link, file, TUI mouse, and focus priority.
      notifyTerminalSurfaceTap(e.clientX, e.clientY, shouldMouseTapFocusKeyboard());
    }, true);

    targetSurface.addEventListener('pointercancel', function(e) {
      if (e.pointerType !== 'mouse') return;
      abandonMouseGesture();
    }, true);

    // Why: Android input injection can pair a mouse-flavored pointerdown with
    // real touch events (SOURCE_MOUSE + TOOL_TYPE_FINGER). If touch arrives,
    // the document touch dispatcher owns the gesture.
    targetSurface.addEventListener('touchstart', function() {
      if (mouseGesture) abandonMouseGesture();
    }, true);

    // Why: the right button now performs selection; the WebView's native
    // context menu on top of it would be pure noise.
    targetSurface.addEventListener('contextmenu', function(e) {
      e.preventDefault();
      e.stopPropagation();
    }, true);
  }
`
