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
  onDocumentGates,
  onUpdateFailed,
  onUpdateManifest,
  showsDocument
} from './mobile-web-shell-shown-document'
import {
  awaitsGates,
  CHECKING,
  OFFLINE,
  gateKey,
  gateState,
  gateVerdict,
  ROUTE_UNAVAILABLE,
  shellRunsGeneration
} from './mobile-web-shell-gates'
import {
  isHostIndexPathname,
  pageRouteRefusalVerdict,
  routeViewOf,
  sameRouteView
} from './page-route-policy'
import { pageDocumentStatePatch } from './page-document-state'
import {
  generationActivated,
  openByOwnRoutes,
  reachableCacheRead,
  reconcileManifestCache,
  rendersRoute
} from './mobile-web-shell-cached-generation'
import {
  acceptsSessionEventFlow,
  step,
  stepNewFlow
} from './mobile-web-shell-session-step'
import { reducePageDocumentLifecycle } from './page-document-lifecycle'
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
    reclaimedOnce: false,
    pageRemountedOnce: false,
    pageReady: false,
    pagePainted: false,
    documentLoaded: false,
    pageBackClaimed: false,
    gates: null,
    cached: null,
    updateNotice: null,
    requestedBuildId: null,
    offeredRoutes: null,
    requestedCompat: null,
    verdicted: false,
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
    offeredRoutes: null,
    requestedCompat: null,
    verdicted: false,
    ...patch,
    gates,
    flow: session.flow + 1
  }
  const gated = gateState(gateVerdict(gates), patch.retriedOnce ?? session.retriedOnce)
  if (gated !== null) {
    return stepNewFlow(session, { ...base, state: gated }, before)
  }
  // Every other verdict reads cache, offline included. Bytes may render before the host answers.
  return stepNewFlow(session, { ...base, state: CHECKING }, [...before, { kind: 'open-cache' }])
}

/** Holds the generation read off disk. Unreachable opens it alone; connected opens it and asks. */
function onCacheRead(
  session: MobileWebShellSession,
  generation: CachedGeneration | null
): MobileWebShellStep {
  const gates = session.gates
  if (gates === null) {
    return step(session, { cached: generation })
  }
  const verdict = gateVerdict(gates)
  if (verdict.kind === 'open') {
    return reachableCacheRead(session, generation, gates)
  }
  if (generation === null || !shellRunsGeneration(generation.compat)) {
    // Nothing to show yet: offline says so unless the dial is still retrying; dialling and pending wait for the host.
    const settledOffline = verdict.kind === 'offline' && gates.retrying !== true
    return step(session, { cached: generation, ...(settledOffline ? { state: OFFLINE } : {}) })
  }
  // Render before the verdict: the bridge holds every desktop-bound frame until this connection's status opens it.
  // An absent route offline means offline, not evidence the unreachable desktop is outdated.
  return openByOwnRoutes(session, generation, {
    unclaimed: verdict.kind === 'offline' ? OFFLINE : CHECKING,
    patch: { cached: generation }
  })
}

function onManifestRead(
  session: MobileWebShellSession,
  manifest: MobileWebShellManifestFacts
): MobileWebShellStep {
  const gates = session.gates
  if (gates === null) {
    return step(session, {})
  }
  // A page already on screen stages a newer build. Cache activation still reconciles in place.
  if (session.state.kind === 'ready') {
    return onUpdateManifest(session, gates, manifest)
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
  // Same build id is the same bytes, so a live generation stays up and a newer one fetches behind it.
  const reconciled = reconcileManifestCache(session, manifest, view)
  const marked = step(reconciled.session, {
    verdicted: true,
    ...(reconciled.session.requestedBuildId !== null ? { requestedCompat: manifest } : {})
  })
  return { session: marked.session, effects: reconciled.effects }
}

// Reenter gates after failure. Child routes share the host slot, so only the host page deletes it.
const refetchAfterDelete: RefetchAfterDelete = (session, gates) =>
  startFlow(
    session,
    gates,
    { retriedOnce: true, cached: null },
    isHostIndexPathname(session.routePathname) ? [{ kind: 'delete-cache' }] : []
  )

// A shell report that the document failed refetches once. The load deadline remounts instead.
function refetchReportedDocument(session: MobileWebShellSession): MobileWebShellStep {
  if (session.state.kind !== 'ready') {
    return step(session, {})
  }
  if (session.retriedOnce || session.gates === null) {
    return step(session, {
      state: { kind: 'failed', reason: 'document-load-failed', retriedOnce: session.retriedOnce }
    })
  }
  return refetchAfterDelete(session, session.gates)
}

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
  if (!acceptsSessionEventFlow(session, event)) {
    return step(session, {})
  }
  switch (event.type) {
    case 'gates-changed':
      if (awaitsGates(session.state)) {
        return session.gates === null || gateKey(session.gates) !== gateKey(event.gates)
          ? startFlow(session, event.gates)
          : step(session, { gates: event.gates })
      }
      return session.state.kind === 'ready'
        ? onDocumentGates(session, event.gates, session.state.compat, startFlow)
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
    case 'activated': {
      // Download landing behind a cached page keeps the offered routes. A late open of the replaced generation does not.
      const activated = generationActivated(session, event)
      if (activated.session.state === session.state || activated.session.state.kind !== 'ready') {
        return activated
      }
      const downloadLanded =
        session.requestedBuildId !== null && activated.session.requestedBuildId === null
      const compat = downloadLanded ? session.requestedCompat : (session.cached?.compat ?? null)
      if (compat == null) {
        return activated
      }
      const withCompat = step(activated.session, {
        state: { ...activated.session.state, compat }
      })
      if (withCompat.session.gates === null) {
        return { session: withCompat.session, effects: activated.effects }
      }
      const judged = onDocumentGates(
        withCompat.session,
        withCompat.session.gates,
        compat,
        startFlow
      )
      return { session: judged.session, effects: [...activated.effects, ...judged.effects] }
    }
    case 'download-failed':
      return showsDocument(session.state)
        ? onUpdateFailed(session, event.cause)
        : onDownloadFailed(session, event.cause)
    case 'shell-failed':
      return event.reason === 'document-load-failed'
        ? refetchReportedDocument(session)
        : reduceShellFailed(session, event.reason, refetchAfterDelete, event.reclaimed === true)
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
          ? {
              ...pageDocumentStatePatch(session, event),
              remountedOnce: false,
              reclaimedOnce: false
            }
          : {}
      )
    case 'page-back-claim':
      return step(session, pageDocumentStatePatch(session, event))
    case 'layout-changed':
      return onLayoutChanged(session, event.wide)
    case 'retry-pressed': {
      // Only explicit retry resets recovery latches; reconnect must not grant another remount.
      const reset = {
        retriedOnce: false,
        remountedOnce: false,
        reclaimedOnce: false,
        pageRemountedOnce: false
      }
      const fresh: MobileWebShellSessionEffect[] =
        retryDeletesCache(session.state) && isHostIndexPathname(session.routePathname)
          ? [{ kind: 'delete-cache' }]
          : []
      return session.gates === null
        ? stepNewFlow(
            session,
            {
              ...reset,
              updateNotice: null,
              requestedBuildId: null,
              offeredRoutes: null,
              requestedCompat: null,
              verdicted: false,
              state: CHECKING,
              flow: session.flow + 1
            },
            fresh
          )
        : startFlow(session, session.gates, { ...reset, cached: null }, fresh)
    }
  }
}
