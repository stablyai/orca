import { afterWritesDrained, disposeTermObservers } from './write-queue'
import { updateScrollIndicator } from './viewport-transform'
import { scope } from './document-scope'
import { logFeedAndEvict } from './selection-state-and-eviction'
import { emitKeyboardAvoidanceMetrics } from './keyboard-avoidance-metrics'
import { emitModesIfChanged } from './mode-mirroring'

export function attachTermObservers() {
  if (!scope.term) {
    return
  }
  disposeTermObservers()
  try {
    scope.termObserverDisposables.push(scope.term.onLineFeed!(logFeedAndEvict))
  } catch {}
  try {
    scope.termObserverDisposables.push(
      scope.term.onScroll!(function () {
        updateScrollIndicator(false)
      })
    )
  } catch {}
  // Why: emit modes on every parsed write so RN's mirror stays current
  // without round-trip; covers \x1b[?2004h/l and alt-screen toggles.
  try {
    if (scope.term.onWriteParsed) {
      scope.termObserverDisposables.push(
        scope.term.onWriteParsed(function () {
          emitModesIfChanged()
          emitKeyboardAvoidanceMetrics()
        })
      )
    }
  } catch {}
  // Initial emit once buffer settles.
  afterWritesDrained(function () {
    emitModesIfChanged()
    emitKeyboardAvoidanceMetrics()
  })
}
