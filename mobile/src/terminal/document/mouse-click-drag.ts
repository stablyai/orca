import { handleDragMove, repositionOverlay, stopEdgeScroll } from './selection-overlay'
import { applyXtermSelection, cancelSelect } from './selection-range'
import { notify } from './host-notify'
import { getMouseTrackingMode, isSafeSgrMouseCoordinate } from './mouse-input-encoding'
import { viewportToCell } from './viewport-cell'
import { scope } from './document-scope'
import { notifyTerminalSurfaceTap } from './surface-tap'
import { viewportToMouseReportCell } from './mouse-report-cell'
import { dispatcherShouldBlockSurface } from './tap-dispatch'

/** A mouse press being tracked from pointerdown to pointerup. */
export type TerminalMouseGesture = {
  startX: number
  startY: number
  lastX: number
  lastY: number
  lastCellKey: string | null
  moved: boolean
  mode: string
  dismissedSelection: boolean
}

// One report per transition, built with the same encoding ladder as
// buildMouseClickInput: SGR pixels (1016) > SGR (1006) > default. Returns ''
// when the mode does not report this transition (x10 has no release, only
// drag/any report motion) or the cell is not encodable.
export function buildMouseButtonReport(kind: string, clientX: number, clientY: number) {
  const mouseTrackingMode = getMouseTrackingMode()
  if (mouseTrackingMode === 'none') {
    return ''
  }
  if (kind === 'motion' && mouseTrackingMode !== 'drag' && mouseTrackingMode !== 'any') {
    return ''
  }
  if (kind === 'release' && mouseTrackingMode === 'x10') {
    return ''
  }
  const cell = viewportToMouseReportCell(clientX, clientY)
  if (!cell) {
    return ''
  }
  const sgrButton = kind === 'motion' ? 32 : 0
  const sgrFinal = kind === 'release' ? 'm' : 'M'
  if (scope.sgrMousePixelsMode) {
    if (!isSafeSgrMouseCoordinate(cell.x) || !isSafeSgrMouseCoordinate(cell.y)) {
      return ''
    }
    return scope.ESC + '[<' + sgrButton + ';' + cell.x + ';' + cell.y + sgrFinal
  }
  if (scope.sgrMouseMode) {
    // Why: xterm increments zero-based mouse cells before encoding reports.
    const sgrCol = cell.col + 1
    const sgrRow = cell.row + 1
    if (!isSafeSgrMouseCoordinate(sgrCol) || !isSafeSgrMouseCoordinate(sgrRow)) {
      return ''
    }
    return scope.ESC + '[<' + sgrButton + ';' + sgrCol + ';' + sgrRow + sgrFinal
  }
  const button = kind === 'motion' ? 64 : kind === 'release' ? 35 : 32
  const col = cell.col + 1 + 32
  const row = cell.row + 1 + 32
  // Why: non-SGR mouse bytes above ASCII are not preserved reliably through
  // the mobile JSON/RPC string path; drop instead of corrupting input.
  if (col > 126 || row > 126) {
    return ''
  }
  return (
    scope.ESC +
    '[M' +
    String.fromCharCode(button) +
    String.fromCharCode(col) +
    String.fromCharCode(row)
  )
}

export function mouseReportCellKey(clientX: number, clientY: number) {
  const cell = viewportToMouseReportCell(clientX, clientY)
  return cell ? cell.col + ',' + cell.row : null
}

export function abandonMouseGesture() {
  const gesture = scope.mouseGesture
  scope.mouseGesture = null
  if (!gesture) {
    return
  }
  if (gesture.mode === 'tracking') {
    // Why: the press report already went to the TUI; a lost pointer must not
    // leave the button latched down on the far side.
    const release = buildMouseButtonReport('release', gesture.lastX, gesture.lastY)
    if (release) {
      notify({ type: 'terminal-input', bytes: release })
    }
  } else if (gesture.mode === 'selecting') {
    if (scope.sel) {
      scope.sel.activeHandle = null
    }
    stopEdgeScroll()
  }
}

export function beginMouseDrag(gesture: TerminalMouseGesture) {
  gesture.moved = true
  if (getMouseTrackingMode() !== 'none') {
    gesture.mode = 'tracking'
    gesture.lastCellKey = mouseReportCellKey(gesture.startX, gesture.startY)
    const press = buildMouseButtonReport('press', gesture.startX, gesture.startY)
    if (press) {
      notify({ type: 'terminal-input', bytes: press })
    }
    return
  }
  const anchor = viewportToCell(gesture.startX, gesture.startY)
  if (!anchor) {
    gesture.mode = 'cancelled'
    return
  }
  // Why: mouse drags select character-anchored ranges like desktop terminals,
  // not the word-seeded long-press selection; reuse the touch handle-drag
  // plumbing (edge scroll included) by acting as a live 'end' handle.
  gesture.mode = 'selecting'
  scope.selMode = 'select'
  scope.sel = { anchor: anchor, focus: anchor, activeHandle: 'end' }
  scope.selectionOverlay!.classList.add('active')
  notify({ type: 'set-select-mode', enabled: true })
  applyXtermSelection()
  repositionOverlay()
}

export function attachSurfaceMouseClickDragHandler(targetSurface: HTMLElement) {
  targetSurface.addEventListener(
    'pointerdown',
    function (e) {
      if (e.pointerType !== 'mouse' || e.button !== 0) {
        return
      }
      if (dispatcherShouldBlockSurface() || !scope.term) {
        return
      }
      // Why: a pointerup lost outside the WebView must not leave the previous
      // gesture latched (tracking press with no release) when the next one lands.
      if (scope.mouseGesture) {
        abandonMouseGesture()
      }
      // Why: mouse pointers have no implicit capture; without it a drag that
      // leaves the surface drops pointermove/pointerup and strands the gesture.
      try {
        if (targetSurface.setPointerCapture) {
          targetSurface.setPointerCapture(e.pointerId)
        }
      } catch {}
      scope.mouseGesture = {
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        lastCellKey: null,
        moved: false,
        mode: 'pending',
        dismissedSelection: false
      }
      if (scope.selMode === 'select') {
        // Why: touch parity — pressing outside the pill dismisses the current
        // selection; the same press may still start a new drag selection.
        cancelSelect()
        scope.mouseGesture.dismissedSelection = true
      }
    },
    true
  )

  targetSurface.addEventListener(
    'pointermove',
    function (e) {
      const gesture = scope.mouseGesture
      if (e.pointerType !== 'mouse' || !gesture || gesture.mode === 'cancelled') {
        return
      }
      if (!scope.term) {
        return
      }
      gesture.lastX = e.clientX
      gesture.lastY = e.clientY
      if ((e.buttons & 1) === 0) {
        // Why: a pointerup lost outside the WebView (capture unavailable) must
        // end the gesture here, or a tracked press stays latched at the TUI.
        // Coordinates first, so the synthesized release lands where the
        // pointer re-entered rather than at the previous cell.
        abandonMouseGesture()
        return
      }
      if (!gesture.moved) {
        const dx = Math.abs(e.clientX - gesture.startX)
        const dy = Math.abs(e.clientY - gesture.startY)
        if (dx + dy <= scope.TAP_SLOP) {
          return
        }
        beginMouseDrag(gesture)
      }
      if (gesture.mode === 'tracking') {
        // Why: one motion report per cell keeps drags bounded by grid size, not
        // by pointermove cadence, so the RN rate limiter is never the bottleneck.
        const cellKey = mouseReportCellKey(e.clientX, e.clientY)
        if (cellKey && cellKey !== gesture.lastCellKey) {
          gesture.lastCellKey = cellKey
          const motion = buildMouseButtonReport('motion', e.clientX, e.clientY)
          if (motion) {
            notify({ type: 'terminal-input', bytes: motion })
          }
        }
      } else if (gesture.mode === 'selecting') {
        handleDragMove('end', e.clientX, e.clientY)
      }
    },
    true
  )

  targetSurface.addEventListener(
    'pointerup',
    function (e) {
      const gesture = scope.mouseGesture
      if (e.pointerType !== 'mouse' || !gesture || e.button !== 0) {
        return
      }
      scope.mouseGesture = null
      if (gesture.mode === 'cancelled' || !scope.term) {
        return
      }
      if (gesture.mode === 'tracking') {
        const release = buildMouseButtonReport('release', e.clientX, e.clientY)
        if (release) {
          notify({ type: 'terminal-input', bytes: release })
        }
        return
      }
      if (gesture.mode === 'selecting') {
        if (scope.sel) {
          scope.sel.activeHandle = null
        }
        stopEdgeScroll()
        repositionOverlay()
        return
      }
      if (dispatcherShouldBlockSurface()) {
        return
      }
      // Why: a dismissing tap only clears the selection (touch parity); it must
      // not also open a link or focus the keyboard underneath.
      if (gesture.dismissedSelection) {
        return
      }
      // Pointer clicks keep their current link, file, TUI mouse, and focus priority.
      notifyTerminalSurfaceTap(e.clientX, e.clientY, false)
    },
    true
  )

  targetSurface.addEventListener(
    'pointercancel',
    function (e) {
      if (e.pointerType !== 'mouse') {
        return
      }
      abandonMouseGesture()
    },
    true
  )

  // Why: Android input injection can pair a mouse-flavored pointerdown with
  // real touch events (SOURCE_MOUSE + TOOL_TYPE_FINGER). If touch arrives,
  // the document touch dispatcher owns the gesture.
  targetSurface.addEventListener(
    'touchstart',
    function () {
      if (scope.mouseGesture) {
        abandonMouseGesture()
      }
    },
    true
  )
}
