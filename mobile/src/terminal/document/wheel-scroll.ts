import { getCellHeight, getTotalScale } from './cell-metrics'
import { notify } from './host-notify'
import { routeScrollLines, shouldRouteScrollToTerminalInput } from './mouse-input-encoding'
import {
  enqueueNormalBufferScrollDelta,
  resetSmoothScrollOffset
} from './normal-buffer-smooth-scroll'
import type { TerminalDocumentScope } from './document-scope'

const WHEEL_SEQUENCE_IDLE_MS = 150

export function wheelEventPixelDeltaY(scope: TerminalDocumentScope, e: WheelEvent) {
  const delta = e.deltaY
  if (typeof delta !== 'number' || !Number.isFinite(delta) || delta === 0) {
    return 0
  }
  // Android external wheels may use lines/pages; iOS trackpads report pixel deltas.
  if (e.deltaMode === 1) {
    return delta * getCellHeight(scope) * getTotalScale(scope)
  }
  if (e.deltaMode === 2) {
    return delta * scope.viewportRect().height
  }
  return delta
}

export function attachSurfaceWheelHandler(
  scope: TerminalDocumentScope,
  targetSurface: HTMLElement
) {
  let lastWheelAt: number | null = null
  targetSurface.addEventListener(
    'wheel',
    function (e) {
      if (scope.touchDispatch.mode === 'select-drag' || !scope.term) {
        return
      }
      // Claim wheels before xterm can emit query-gated cursor keys or scroll its hidden viewport; use the touch router instead.
      e.preventDefault()
      e.stopPropagation()
      if (!scope.interactionActive) {
        return
      }

      // Swallow ctrl+wheel trackpad pinch so it cannot send cursor keys to the TUI.
      if (e.ctrlKey) {
        return
      }

      const deltaY = wheelEventPixelDeltaY(scope, e)
      if (deltaY === 0) {
        return
      }

      const now = performance.now()
      if (lastWheelAt === null || now - lastWheelAt > WHEEL_SEQUENCE_IDLE_MS) {
        scope.wheelAccumDeltaY = 0
        notify(scope, { type: 'terminal-interaction' })
      }
      lastWheelAt = now
      if (shouldRouteScrollToTerminalInput(scope)) {
        resetSmoothScrollOffset(scope)
        const effectiveCellH = getCellHeight(scope) * getTotalScale(scope)
        if (!(effectiveCellH > 0)) {
          return
        }
        scope.wheelAccumDeltaY += deltaY
        const lines = Math.trunc(scope.wheelAccumDeltaY / effectiveCellH)
        if (lines !== 0) {
          scope.wheelAccumDeltaY -= lines * effectiveCellH
          routeScrollLines(scope, lines, e.clientX, e.clientY)
        }
        return
      }
      scope.wheelAccumDeltaY = 0
      enqueueNormalBufferScrollDelta(scope, deltaY)
    },
    { capture: true, passive: false }
  )
}
