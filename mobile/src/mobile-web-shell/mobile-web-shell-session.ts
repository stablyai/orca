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

// Route initial entry, retry and recovery through the same gates; run before-effects even when gates close so suspect cache still gets deleted.
function startFlow(
  session: MobileWebShellSession,
  gates: MobileWebShellGates,
  patch: Partial<MobileWebShellSession> = {},
  before: readonly MobileWebShellSessionEffect[] = []
): MobileWebShellStep {
  // Advance flow so replaced work and duplicate mid-check status refetches cannot land here.
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
  // Offline still sweeps/reads cache; onCacheRead skips only the host compatibility check.
  return step(session, { ...base, state: CHECKING }, [...before, { kind: 'open-cache' }])
}

function onCacheRead(
  session: MobileWebShellSession,
  generation: CachedGeneration | null
): MobileWebShellStep {
  const gates = session.gates
  // Wait for settled reachability before deciding whether cache needs a host compatibility check.
  if (gates === null || gates.reachability === 'connecting') {
    return step(session, { cached: generation })
  }
  if (gates.reachability === 'unreachable') {
    // No current host verdict exists offline; open trusted cache and recheck on the next connected entry.
    if (generation === null) {
      return step(session, { cached: null, state: { kind: 'offline' } })
    }
    // Use cached routes offline; an absent route means offline, not evidence the unreachable desktop is outdated.
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
  // Check version/schema before routes because incompatible manifests cannot reliably describe a screen.
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
    // Keep route facts so a later layout flip can restart a newly servable screen.
    const refusal = session.appNamesRoute
      ? pageRouteRefusalVerdict(manifest.routes, session.routePathname, session.wide)
      : null
    const state =
      refusal === null ? ROUTE_UNAVAILABLE : ({ kind: 'wall', verdict: refusal } as const)
    return step(session, { ...view, state })
  }
  // Build ids digest assets, so matching ids can open cached bytes unchanged.
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

// Retry suspect disk bytes once via delete/refetch; renderer loss gets one remount without deletion; unavailable isolation is terminal.
// Ignore reports outside ready: retired-view batches must not interrupt recovery already in flight.
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
  // Reenter gates after failure: ready may hold unreadable reconnect status, which must not become a bundle-unavailable wall.
  return startFlow(session, session.gates, { retriedOnce: true, cached: null }, [
    { kind: 'delete-cache' }
  ])
}

// Record the resulting decision once for Troubleshoot; release builds forward no console logs.
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

// Fall back to intact cached bytes under their own routes, checking compatibility when the host remains reachable.
// Name only bundle refusals: link loss cannot establish an update existed; absent cache still gets download failure.
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
  // Read current gates because they can change while fetching without restarting the flow.
  const verdict = gateVerdict(gates)
  const gated = gateState(verdict, session.retriedOnce)
  if (gated !== null) {
    return step(session, { state: gated })
  }
  return openByOwnRoutes(session, cached, {
    // Missing cached routes remain a retryable download failure after the new manifest claimed them or never arrived.
    unclaimed: { kind: 'failed', reason: 'download-failed', retriedOnce: session.retriedOnce },
    served: { updateNotice: readFailureSide(cause.reason) === 'bundle' ? 'update-failed' : null },
    wall: cachedGenerationWall(verdict, gates, cached.compat)
  })
}

function onLayoutChanged(session: MobileWebShellSession, wide: boolean): MobileWebShellStep {
  const view = routeViewOf(session.routes, session.routePathname, wide)
  if (session.gates === null || sameRouteView(view, session)) {
    return step(session, { wide })
  }
  // Preserve the flow counter so startFlow advances beyond every result still in flight.
  const fresh = {
    ...createMobileWebShellSession(session.routePathname, wide, session.appNamesRoute),
    flow: session.flow
  }
  return startFlow(fresh, session.gates)
}

// Keep transitions pure; the runner may drop abandoned results, while this flow guard rejects late results it reports.
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
      // Count only download activation as an update: fetch rereads the manifest, so the committed build may differ from the offered id.
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
      // Only explicit retry resets recovery latches; reconnect must not grant another remount.
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
