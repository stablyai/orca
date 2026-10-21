import type { MobileWebShellFailureReason } from '../../modules/orca-mobile-web-shell/src/load-state'
import { evaluateMobileWebBundleCompat } from '../transport/mobile-web-bundle-compat'
import type {
  CachedGeneration,
  MobileWebShellGates,
  MobileWebShellManifestFacts,
  MobileWebShellSession,
  MobileWebShellSessionEffect,
  MobileWebShellSessionEvent,
  MobileWebShellStep
} from './mobile-web-shell-session-contract'
import {
  readFailureSide,
  type MobileWebShellUpdateFailureCause,
  type MobileWebShellUpdateFailureFacts
} from './mobile-web-shell-update-failure'
import { updateFailureOutcomeOf } from './mobile-web-shell-update-failure-outcome'
import {
  awaitsGates,
  cachedGenerationWall,
  CHECKING,
  gateKey,
  gateState,
  gateVerdict,
  ROUTE_UNAVAILABLE
} from './mobile-web-shell-gates'
import { pageRouteRefusalVerdict, routeViewOf, sameRouteView } from './page-route-policy'
import { CLEAR_PAGE_DOCUMENT_STATE, pageDocumentStatePatch } from './page-document-state'
import { openByOwnRoutes, openCached, rendersRoute } from './mobile-web-shell-cached-generation'
import { step } from './mobile-web-shell-session-step'
import { AWAIT_DOCUMENT_LOAD, reducePageDocumentLifecycle } from './page-document-lifecycle'

export function createMobileWebShellSession(
  routePathname: string,
  wide = false,
  appNamesRoute = true
): MobileWebShellSession {
  return {
    routePathname,
    appNamesRoute,
    wide,
    pageRoutes: [],
    pageRouteGrants: [],
    routeGrants: [],
    routes: undefined,
    ownsHostArea: false,
    state: CHECKING,
    retriedOnce: false,
    remountedOnce: false,
    pageReady: false,
    pagePainted: false,
    documentLoaded: false,
    pageBackClaimed: false,
    gates: null,
    cached: null,
    updateNotice: null,
    requestedBuildId: null,
    flow: 0
  }
}

/**
 * The step the gate takes, and every entry into the flow goes through it.
 *
 * The first run, the one "Try again" returns to, and the recovery a failed view triggers, which
 * passes the delete it owes as `before` so the cache goes whatever the gate then decides.
 */
function startFlow(
  session: MobileWebShellSession,
  gates: MobileWebShellGates,
  patch: Partial<MobileWebShellSession> = {},
  before: readonly MobileWebShellSessionEffect[] = []
): MobileWebShellStep {
  // A new flow, so nothing the replaced one has in flight can land on this one. That is also what
  // keeps a status refetch arriving mid-check from running the cache read and the download twice.
  const base = {
    updateNotice: null,
    requestedBuildId: null,
    ...patch,
    gates,
    flow: session.flow + 1
  }
  const gated = gateState(gateVerdict(gates), patch.retriedOnce ?? session.retriedOnce)
  if (gated !== null) {
    return step(session, { ...base, state: gated }, before)
  }
  // Offline sweeps and reads the cache exactly as a connected host does. What it skips is the
  // compat check, and `onCacheRead` is where that shows.
  return step(session, { ...base, state: CHECKING }, [...before, { kind: 'open-cache' }])
}

/** Holds the generation read off disk, and opens it at once only when the host is unreachable. */
function onCacheRead(
  session: MobileWebShellSession,
  generation: CachedGeneration | null
): MobileWebShellStep {
  const gates = session.gates
  // Neither says the host cannot be reached: a dial in progress is a connection about to land, and
  // gates that have not arrived have said nothing yet. Opening the cache on either would skip a
  // compat check that the settled answer is what makes answerable.
  if (gates === null || gates.reachability === 'connecting') {
    return step(session, { cached: generation })
  }
  if (gates.reachability === 'unreachable') {
    // No compat check on this path, by design: the generation was compatible when it was cached and
    // a host nobody can reach cannot have changed since. The next entry while connected re-checks.
    if (generation === null) {
      return step(session, { cached: null, state: { kind: 'offline' } })
    }
    // The cached bundle's own list, which is the only one an unreachable host can be judged by. A
    // route it lacks is the offline screen, as with nothing cached: an unreachable host cannot be
    // told too old, and connecting is what fetches the bundle that may carry the route.
    return openByOwnRoutes(session, generation, {
      unclaimed: { kind: 'offline' },
      patch: { cached: generation }
    })
  }
  return step(session, { cached: generation, state: CHECKING }, [{ kind: 'read-manifest' }])
}

function onManifestRead(
  session: MobileWebShellSession,
  manifest: MobileWebShellManifestFacts
): MobileWebShellStep {
  const gates = session.gates
  if (gates === null) {
    return step(session, {})
  }
  // Before the route question: a page below the floor is a desktop too old whatever it lists, and
  // a schema this shell cannot read leaves the route list unreadable too.
  const verdict = evaluateMobileWebBundleCompat({
    hostCapabilities: gates.hostCapabilities,
    hostStatus: gates.hostStatus,
    manifest
  })
  if (verdict.kind === 'blocked') {
    return step(session, { state: { kind: 'wall', verdict } })
  }
  const view = {
    ...routeViewOf(manifest.routes, session.routePathname, session.wide),
    routes: manifest.routes
  }
  if (!rendersRoute(view.pageRoutes, session.routePathname)) {
    // The view is kept so a layout flip that would serve the route restarts the session.
    const refusal = session.appNamesRoute
      ? pageRouteRefusalVerdict(manifest.routes, session.routePathname, session.wide)
      : null
    const state =
      refusal === null ? ROUTE_UNAVAILABLE : ({ kind: 'wall', verdict: refusal } as const)
    return step(session, { ...view, state })
  }
  // Same build id is the same bytes (the id is their digest), so the generation on disk opens as is.
  const cached = session.cached
  if (cached?.buildId === manifest.buildId) {
    return openCached(session, cached, view)
  }
  return step(
    session,
    {
      ...view,
      requestedBuildId: manifest.buildId,
      state: {
        kind: 'fetching',
        completedAssets: 0,
        totalAssets: manifest.totalAssets,
        receivedBytes: 0,
        totalBytes: manifest.totalBytes
      }
    },
    [{ kind: 'download' }]
  )
}

/**
 * B3's contract, and the only place it is interpreted.
 *
 * `generation-unreadable` and `document-load-failed` say the bytes on disk are suspect, so the
 * host's cache goes and the flow runs once more. `render-process-gone` says nothing about the
 * bytes — renderer memory pressure and a WebView provider update look identical from here — so it
 * remounts and never deletes. `isolation-unavailable` is terminal on the first report: the fence is
 * the whole reason this view exists, and a device that cannot install it will not on a retry.
 *
 * Only `ready` hears any of it. The view exists in no other state, so a report arriving outside one
 * is from a view that has already been taken off screen: the second failure of a native batch that
 * the first one's recovery has already answered, or a mount that a wall or a retry has replaced.
 * Acting on it would strand the recovery already in flight — the delete-and-refetch would be made
 * terminal while its own cache read was still coming back, and that read would then drag the
 * session back to checking behind a failure screen.
 */
function onShellFailed(
  session: MobileWebShellSession,
  reason: MobileWebShellFailureReason
): MobileWebShellStep {
  if (session.state.kind !== 'ready') {
    return step(session, {})
  }
  const failed = { kind: 'failed', reason, retriedOnce: session.retriedOnce } as const
  if (reason === 'isolation-unavailable') {
    return step(session, { state: failed })
  }
  if (reason === 'render-process-gone') {
    return session.remountedOnce
      ? step(session, { state: failed })
      : step(session, { remountedOnce: true }, [{ kind: 'remount' }])
  }
  if (session.retriedOnce || session.gates === null) {
    return step(session, { state: failed })
  }
  // Through the gate, not straight back to the manifest check: the gates a ready session holds are
  // whatever the last reconnect stored, so a recovery that trusted them walled hosts whose status
  // had gone unreadable underneath a workspace that was, until this failure, working.
  return startFlow(session, session.gates, { retriedOnce: true, cached: null }, [
    { kind: 'delete-cache' }
  ])
}

/** The decision below, plus one record of it: a release build logs nothing, so what the shell
 *  refused and what it showed instead is written down for Troubleshoot. */
function onDownloadFailed(
  session: MobileWebShellSession,
  cause: MobileWebShellUpdateFailureCause
): MobileWebShellStep {
  const decided = decideDownloadFailed(session, cause)
  const failure: MobileWebShellUpdateFailureFacts = {
    ...cause,
    offeredBuildId: session.requestedBuildId,
    cachedBuildId: session.cached?.buildId ?? null,
    ...updateFailureOutcomeOf(decided.session.state)
  }
  return { ...decided, effects: [...decided.effects, { kind: 'record-update-failure', failure }] }
}

/**
 * The read did not produce a generation, and what follows is decided by what is already on disk.
 *
 * With nothing cached there is nothing to show, so the refusal is the screen. With a generation
 * cached there is: it is the same one the offline gate opens without being asked. Refusing the new
 * bytes was right — a truncated asset does not hash, and a host that will not answer has not been
 * read — but a wall over an intact workspace refuses a screen twice. The same branch either way,
 * because the link going and the bundle being refused leave the phone holding exactly the same
 * thing.
 *
 * Judged against the host first, unlike the offline branch: it was compatible when it was written,
 * and this host can be reached and may have moved since — which is usually why an update was there
 * to fail. A generation outside its window earns the wall, not the download-failed screen.
 *
 * Only the bundle-side refusal is named: a link that went says nothing about an update having been
 * there to fail, and the notice would be claiming a generation this phone never heard of.
 */
function decideDownloadFailed(
  session: MobileWebShellSession,
  cause: MobileWebShellUpdateFailureCause
): MobileWebShellStep {
  const cached = session.cached
  const gates = session.gates
  if (cached === null || gates === null) {
    return step(session, {
      state: { kind: 'failed', reason: 'download-failed', retriedOnce: session.retriedOnce }
    })
  }
  // The gates may have moved under the download: a `fetching` session does not await them, so the
  // verdict here is read fresh and answered with the shell's one answer for it.
  const verdict = gateVerdict(gates)
  const gated = gateState(verdict, session.retriedOnce)
  if (gated !== null) {
    return step(session, { state: gated })
  }
  return openByOwnRoutes(session, cached, {
    // The newer manifest claimed this route or never arrived, so the cache lacking it is this
    // download's failure, with its retry.
    unclaimed: { kind: 'failed', reason: 'download-failed', retriedOnce: session.retriedOnce },
    served: { updateNotice: readFailureSide(cause.reason) === 'bundle' ? 'update-failed' : null },
    wall: cachedGenerationWall(verdict, gates, cached.compat)
  })
}

/** A layout-class change keeps the session when its view does not move, and restarts it otherwise. */
function onLayoutChanged(session: MobileWebShellSession, wide: boolean): MobileWebShellStep {
  const view = routeViewOf(session.routes, session.routePathname, wide)
  // Without gates no manifest has been read, so there is no view to restart.
  if (session.gates === null || sameRouteView(view, session)) {
    return step(session, { wide })
  }
  // Still counting flows, so nothing the old session has in flight lands on this one.
  const fresh = {
    ...createMobileWebShellSession(session.routePathname, wide, session.appNamesRoute),
    flow: session.flow
  }
  return startFlow(fresh, session.gates)
}

/**
 * One transition of the hybrid shell session: a state and the effects the runner owes it.
 *
 * Pure, so every rule above is a table test rather than a simulator run. The runner may drop an
 * effect's result (an unmount, a host change) but must never invent one, and a result it reports
 * late is dropped here by its flow rather than by whatever state the session happens to be in.
 */
export function reduceMobileWebShellSession(
  session: MobileWebShellSession,
  event: MobileWebShellSessionEvent
): MobileWebShellStep {
  if ('flow' in event && event.flow !== session.flow) {
    return step(session, {})
  }
  switch (event.type) {
    case 'gates-changed':
      return awaitsGates(session.state) &&
        (session.gates === null || gateKey(session.gates) !== gateKey(event.gates))
        ? startFlow(session, event.gates)
        : step(session, { gates: event.gates })
    case 'cache-read':
      return onCacheRead(session, event.generation)
    case 'manifest-read':
      return onManifestRead(session, event.manifest)
    case 'fetch-progress':
      return session.state.kind === 'fetching'
        ? step(session, {
            state: {
              kind: 'fetching',
              completedAssets: event.completedAssets,
              totalAssets: event.totalAssets,
              receivedBytes: event.receivedBytes,
              totalBytes: event.totalBytes
            }
          })
        : step(session, {})
    case 'download-staged':
      return session.state.kind === 'fetching'
        ? step(session, { state: { kind: 'activating', source: 'download' } })
        : step(session, {})
    case 'activated':
      // Only a download's activation is an update that landed. Not build-id equality: the fetch
      // re-reads the manifest, so what it commits can be newer than what this flow was offered.
      return step(
        session,
        {
          ...CLEAR_PAGE_DOCUMENT_STATE,
          state: {
            kind: 'ready',
            generationDirectory: event.generationDirectory,
            sessionId: event.sessionId,
            buildId: event.buildId,
            totalBytes: event.totalBytes,
            elapsedMs: event.elapsedMs
          }
        },
        session.state.kind === 'activating' && session.state.source === 'download'
          ? [{ kind: 'forget-update-failures' }, AWAIT_DOCUMENT_LOAD]
          : [AWAIT_DOCUMENT_LOAD]
      )
    case 'download-failed':
      return onDownloadFailed(session, event.cause)
    case 'shell-failed':
      return onShellFailed(session, event.reason)
    case 'remounted':
    case 'document-started':
    case 'document-loaded':
    case 'page-ready-deadline':
    case 'document-load-deadline':
      return reducePageDocumentLifecycle(session, event, (failed) =>
        onShellFailed(failed, 'document-load-failed')
      )
    case 'page-ready':
    case 'page-painted':
    case 'page-back-claim':
      return step(session, pageDocumentStatePatch(session, event))
    case 'layout-changed':
      return onLayoutChanged(session, event.wide)
    case 'retry-pressed':
      // Clears both latches, so the delete-and-refetch and the remount are each available again.
      // Only here: a reconnect is not a reason to grant a second remount of the same session.
      return session.gates === null
        ? step(session, {
            retriedOnce: false,
            remountedOnce: false,
            updateNotice: null,
            requestedBuildId: null,
            state: CHECKING,
            flow: session.flow + 1
          })
        : startFlow(session, session.gates, {
            retriedOnce: false,
            remountedOnce: false,
            cached: null
          })
  }
}
