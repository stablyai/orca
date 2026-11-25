import {
  evaluateMobileWebBundleCompat,
  type MobileWebBundleCompatManifest
} from '../../transport/web-bundle/mobile-web-bundle-compat'
import type {
  MobileWebShellGates,
  MobileWebShellManifestFacts,
  MobileWebShellSession,
  MobileWebShellSessionEvent,
  MobileWebShellSessionState,
  MobileWebShellStep
} from './mobile-web-shell-session-contract'
import {
  readFailureSide,
  type MobileWebShellUpdateFailureCause
} from '../update-recovery/mobile-web-shell-update-failure'
import { updateFailureRecordEffect } from '../update-recovery/mobile-web-shell-update-failure-outcome'
import { cachedGenerationWall, gateVerdict } from '../host-gates/mobile-web-shell-gates'
import { CLEAR_PAGE_DOCUMENT_STATE } from '../page-document/page-document-state'
import { step } from './mobile-web-shell-session-step'
import { AWAIT_DOCUMENT_LOAD } from '../page-document/page-document-lifecycle'

// The reducer's flow entry, for a document the verdict sends back through the manifest.
type Reenter = (
  session: MobileWebShellSession,
  gates: MobileWebShellGates,
  patch?: Partial<MobileWebShellSession>
) => MobileWebShellStep

// A page on screen or about to open from cache, as opposed to a download about to become one.
export function showsDocument(state: MobileWebShellSessionState): boolean {
  return state.kind === 'ready' || (state.kind === 'activating' && state.source === 'cache')
}

// Judge the shown document against each new connection's status; until one opens it, gates are only stored and the bridge holds.
export function onDocumentGates(
  session: MobileWebShellSession,
  gates: MobileWebShellGates,
  compat: MobileWebBundleCompatManifest,
  reenter: Reenter
): MobileWebShellStep {
  const verdict = gateVerdict(gates)
  if (verdict.kind === 'wall') {
    return step(session, { gates, state: { kind: 'wall', verdict: verdict.verdict } })
  }
  if (verdict.kind === 'status-unreadable' && !session.verdicted) {
    // A page that never talked shows the status failure an entry would, instead of waiting on a verdict that may never come.
    return reenter(session, gates)
  }
  if (verdict.kind !== 'open') {
    return step(session, { gates })
  }
  const wall = cachedGenerationWall(verdict, gates, compat)
  if (wall === null) {
    // The first open verdict, and the first after a resume, check for a newer build behind the running page.
    return session.verdicted && !session.resumeCheckDue
      ? step(session, { gates })
      : step(session, { gates, verdicted: true, resumeCheckDue: false }, [
          { kind: 'read-manifest' }
        ])
  }
  // A page that may have talked walls instead of reloading under the user (design 3.11).
  if (session.verdicted) {
    return step(session, { gates, state: { kind: 'wall', verdict: wall } })
  }
  // Bytes opened before any verdict never talked: reenter so the desktop's manifest decides, as an entry without cache would.
  return reenter(session, gates)
}

// A resume asks again, since a desktop updated while the app was away would otherwise wait for the next launch.
// A swap reopens through the same gates: the open-cache commits the waiting build and the page reopens where it was.
export function onResumeEvent(
  session: MobileWebShellSession,
  event: 'app-resumed' | 'update-swap',
  reenter: Reenter
): MobileWebShellStep {
  const gates = session.gates
  if (session.state.kind !== 'ready' || gates === null) {
    return step(session, {})
  }
  if (event === 'update-swap') {
    return reenter(session, gates, { cached: null })
  }
  // A page still awaiting its first verdict asks once that verdict opens.
  return session.verdicted
    ? onDocumentGates({ ...session, resumeCheckDue: true }, gates, session.state.compat, reenter)
    : step(session, {})
}

// A newer build behind a running page stages for a later entry, or for a resume where every page reading it may reload.
export function onUpdateManifest(
  session: MobileWebShellSession,
  gates: MobileWebShellGates,
  manifest: MobileWebShellManifestFacts
): MobileWebShellStep {
  const shown = session.state.kind === 'ready' ? session.state.buildId : session.cached?.buildId
  const verdict = evaluateMobileWebBundleCompat({
    hostCapabilities: gates.hostCapabilities,
    hostStatus: gates.hostStatus,
    manifest
  })
  return manifest.buildId === shown || verdict.kind === 'blocked'
    ? step(session, {})
    : step(session, { requestedBuildId: manifest.buildId }, [{ kind: 'stage-update' }])
}

// A failed update behind a shown page keeps the page and leaves Troubleshoot evidence; the next entry asks again.
export function onUpdateFailed(
  session: MobileWebShellSession,
  cause: MobileWebShellUpdateFailureCause
): MobileWebShellStep {
  return step(
    session,
    readFailureSide(cause.reason) === 'bundle' ? { updateNotice: 'update-failed' } : {},
    [updateFailureRecordEffect(session, cause, session.state)]
  )
}

export function onActivated(
  session: MobileWebShellSession,
  event: Extract<MobileWebShellSessionEvent, { type: 'activated' }>,
  reenter: Reenter
): MobileWebShellStep {
  const fromCache = session.state.kind === 'activating' && session.state.source === 'cache'
  const compat = fromCache ? session.cached?.compat : session.requestedCompat
  if (compat == null) {
    return step(session, {})
  }
  // Count only download activation as an update; opening cache does not.
  const opened = step(
    session,
    {
      ...CLEAR_PAGE_DOCUMENT_STATE,
      state: {
        kind: 'ready',
        generationDirectory: event.generationDirectory,
        sessionId: event.sessionId,
        buildId: event.buildId,
        totalBytes: event.totalBytes,
        elapsedMs: event.elapsedMs,
        compat
      }
    },
    fromCache ? [AWAIT_DOCUMENT_LOAD] : [{ kind: 'forget-update-failures' }, AWAIT_DOCUMENT_LOAD]
  )
  if (opened.session.gates === null) {
    return opened
  }
  // Gates that landed while activating judge the new document now.
  const judged = onDocumentGates(opened.session, opened.session.gates, compat, reenter)
  return { session: judged.session, effects: [...opened.effects, ...judged.effects] }
}
