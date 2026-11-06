import { evaluateMobileWebBundleCompat } from '../transport/web-bundle/mobile-web-bundle-compat'
import type {
  CachedGeneration,
  MobileWebShellGates,
  MobileWebShellManifestFacts,
  MobileWebShellSession,
  MobileWebShellSessionEffect,
  MobileWebShellSessionEvent,
  MobileWebShellStep
} from './mobile-web-shell-session-contract'
import { onDownloadFailed } from './mobile-web-shell-download-failure'
import {
  awaitsGates,
  CHECKING,
  OFFLINE,
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
import {
  reduceShellFailed,
  retryDeletesCache,
  type RefetchAfterDelete
} from './shell-failure-recovery'

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
    pageRemountedOnce: false,
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
      // A first open has nothing to show offline; keep checking while the dial is still retrying.
      return step(session, { cached: null, ...(gates.retrying === true ? {} : { state: OFFLINE }) })
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

// Reenter gates after failure: ready may hold unreadable reconnect status, which must not become a bundle-unavailable wall.
const refetchAfterDelete: RefetchAfterDelete = (session, gates) =>
  startFlow(session, gates, { retriedOnce: true, cached: null }, [{ kind: 'delete-cache' }])

function onLayoutChanged(session: MobileWebShellSession, wide: boolean): MobileWebShellStep {
  if (session.state.kind === 'failed' && session.state.reason === 'host-profile-unreadable') {
    return step(session, { wide })
  }
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
      return reduceShellFailed(session, event.reason, refetchAfterDelete)
    case 'remounted':
    case 'document-started':
    case 'document-loaded':
    case 'page-ready-deadline':
    case 'document-load-deadline':
      return reducePageDocumentLifecycle(session, event, (failed) =>
        reduceShellFailed(failed, 'document-load-failed', refetchAfterDelete)
      )
    case 'page-ready':
      return step(
        session,
        pageDocumentStatePatch(session, event),
        session.state.kind === 'ready' ? [{ kind: 'cancel-deadlines' }] : []
      )
    case 'page-painted':
      // A painted remount refills the renderer-loss budget; only a loss before paint walls.
      // The page-failure budget stays spent: a page that paints and then faults would otherwise remount forever.
      return step(
        session,
        session.state.kind === 'ready'
          ? { ...pageDocumentStatePatch(session, event), remountedOnce: false }
          : {}
      )
    case 'page-back-claim':
      return step(session, pageDocumentStatePatch(session, event))
    case 'layout-changed':
      return onLayoutChanged(session, event.wide)
    case 'retry-pressed': {
      // Only explicit retry resets recovery latches; reconnect must not grant another remount.
      const reset = { retriedOnce: false, remountedOnce: false, pageRemountedOnce: false }
      const fresh: MobileWebShellSessionEffect[] = retryDeletesCache(session.state)
        ? [{ kind: 'delete-cache' }]
        : []
      return session.gates === null
        ? step(
            session,
            {
              ...reset,
              updateNotice: null,
              requestedBuildId: null,
              state: CHECKING,
              flow: session.flow + 1
            },
            fresh
          )
        : startFlow(session, session.gates, { ...reset, cached: null }, fresh)
    }
  }
}
