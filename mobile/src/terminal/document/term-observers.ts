import { afterWritesDrained, disposeTermObservers } from './write-queue'
import { updateScrollIndicator } from './viewport-transform'
import type { TerminalDocumentScope } from './document-scope'
import { logFeedAndEvict } from './selection-state-and-eviction'
import { emitKeyboardAvoidanceMetrics } from './keyboard-avoidance-metrics'
import { emitModesIfChanged } from './mode-mirroring'
import { reportLaidOutCellBox } from './cell-metrics-probe'

export function attachTermObservers(scope: TerminalDocumentScope) {
  if (!scope.term) {
    return
  }
  disposeTermObservers(scope)
  scope.reportedCellBox = ''
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
      })
    )
  } catch {}
  // Why: emit modes on every parsed write so RN's mirror stays current
  // without round-trip; covers \x1b[?2004h/l and alt-screen toggles.
  try {
    if (scope.term.onWriteParsed) {
      scope.termObserverDisposables.push(
        scope.term.onWriteParsed(function () {
          emitModesIfChanged(scope)
          emitKeyboardAvoidanceMetrics(scope)
        })
      )
    }
  } catch {}
  // Why: onDimensionsChange skips a renderer swap and a DPR change; every one of them re-renders.
  try {
    if (scope.term.onRender) {
      scope.termObserverDisposables.push(
        scope.term.onRender(function () {
          reportLaidOutCellBox(scope)
        })
      )
    }
  } catch {}
  // Initial emit once buffer settles.
  afterWritesDrained(scope, function () {
    emitModesIfChanged(scope)
    emitKeyboardAvoidanceMetrics(scope)
  })
}
