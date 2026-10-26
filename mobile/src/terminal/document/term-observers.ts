import { afterWritesDrained, disposeTermObservers } from './write-queue'
import { paintBottomRowBackdrop } from './bottom-row-backdrop'
import { updateScrollIndicator } from './viewport-transform'
import type { TerminalDocumentScope } from './document-scope'
import { logFeedAndEvict } from './selection-state-and-eviction'
import { emitKeyboardAvoidanceMetrics } from './keyboard-avoidance-metrics'
import { emitModesIfChanged } from './mode-mirroring'
import { reportLaidOutCellBox } from './laid-out-cell-box'

export function attachTermObservers(scope: TerminalDocumentScope) {
  if (!scope.term) {
    return
  }
  disposeTermObservers(scope)
  try {
    scope.termObserverDisposables.push(
      scope.term.onLineFeed!(function () {
        logFeedAndEvict(scope)
      })
    )
  } catch {}
  try {
    scope.termObserverDisposables.push(
      scope.term.onScroll!(function () {
        updateScrollIndicator(scope, false)
        paintBottomRowBackdrop(scope)
      })
    )
  } catch {}
  // Mirror modes after every parsed write so native paste/alternate-screen state needs no round trip.
  try {
    if (scope.term.onWriteParsed) {
      scope.termObserverDisposables.push(
        scope.term.onWriteParsed(function () {
          emitModesIfChanged(scope)
          emitKeyboardAvoidanceMetrics(scope)
          paintBottomRowBackdrop(scope)
        })
      )
    }
  } catch {}
  // Dimensions changes miss renderer/DPR swaps; all three cause render events.
  try {
    if (scope.term.onRender) {
      scope.termObserverDisposables.push(
        scope.term.onRender(function () {
          reportLaidOutCellBox(scope)
          paintBottomRowBackdrop(scope)
        })
      )
    }
  } catch {}
  afterWritesDrained(scope, function () {
    emitModesIfChanged(scope)
    emitKeyboardAvoidanceMetrics(scope)
  })
}
