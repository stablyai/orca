import type {
  MobileWebShellReportedFailure,
  MobileWebShellGates,
  MobileWebShellSession,
  MobileWebShellSessionState,
  MobileWebShellStep
} from './mobile-web-shell-session-contract'
import { step } from './mobile-web-shell-session-step'

// The session reducer owns flow restarts; recovery only decides when deleting the host cache is warranted.
export type RefetchAfterDelete = (
  session: MobileWebShellSession,
  gates: MobileWebShellGates
) => MobileWebShellStep

// Each failure keeps its own single retry so one cannot use up another's. Only an unreadable manifest deletes files unasked:
// a failed document proves nothing about its bytes, so a page bug must not cost a redownload on every entry.
// Ignore reports outside ready: retired-view batches must not interrupt recovery already in flight.
export function reduceShellFailed(
  session: MobileWebShellSession,
  reason: MobileWebShellReportedFailure,
  refetch: RefetchAfterDelete
): MobileWebShellStep {
  if (reason === 'host-profile-unreadable') {
    // Terminal failures advance flow so pending startup work is cancelled and its completions rejected.
    return step(session, { state: failedState(session, reason), flow: session.flow + 1 })
  }
  if (session.state.kind !== 'ready') {
    return step(session, {})
  }
  switch (reason) {
    case 'isolation-unavailable':
      return step(session, { state: failedState(session, reason), flow: session.flow + 1 })
    case 'render-process-gone':
      return session.remountedOnce
        ? step(session, { state: failedState(session, reason) })
        : step(session, { remountedOnce: true }, [{ kind: 'remount' }])
    case 'document-load-failed':
      return session.pageRemountedOnce
        ? step(session, { state: failedState(session, reason) })
        : step(session, { pageRemountedOnce: true }, [{ kind: 'remount' }])
    case 'generation-unreadable':
      return session.retriedOnce || session.gates === null
        ? step(session, { state: failedState(session, reason) })
        : refetch(session, session.gates)
  }
}

// Try again after these must not reopen the files that just failed: a damaged tree would fail again on every tap.
export function retryDeletesCache(state: MobileWebShellSessionState): boolean {
  return (
    state.kind === 'failed' &&
    (state.reason === 'document-load-failed' || state.reason === 'generation-unreadable')
  )
}

function failedState(
  session: MobileWebShellSession,
  reason: MobileWebShellReportedFailure
): MobileWebShellSessionState {
  return { kind: 'failed', reason, retriedOnce: session.retriedOnce }
}
