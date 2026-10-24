import type {
  CachedGeneration,
  MobileWebShellBlockedVerdict,
  MobileWebShellGates,
  MobileWebShellManifestFacts,
  MobileWebShellSession,
  MobileWebShellSessionState,
  MobileWebShellStep
} from './mobile-web-shell-session-contract'
import { cachedGenerationWall, CHECKING, gateVerdict } from './mobile-web-shell-gates'
import { AWAIT_DOCUMENT_LOAD } from './page-document-lifecycle'
import { CLEAR_PAGE_DOCUMENT_STATE } from './page-document-state'
import { matchesRoutePattern, routeViewOf, sameRouteView } from './page-route-policy'
import { step } from './mobile-web-shell-session-step'

/**
 * Putting a generation that is already on disk on screen, and deciding whether this route is one
 * that bundle carries. The only judge available when a newer manifest is absent or refused, so it
 * is the reducer's cache path and its refused-update path both.
 */

export function rendersRoute(pageRoutes: readonly string[], pathname: string): boolean {
  return pageRoutes.some((pattern) => matchesRoutePattern(pathname, pattern))
}

export function openCached(
  session: MobileWebShellSession,
  generation: CachedGeneration,
  patch: Partial<MobileWebShellSession> = {}
): MobileWebShellStep {
  return step(session, { ...patch, state: { kind: 'activating', source: 'cache' } }, [
    {
      kind: 'open-generation',
      directory: generation.directory,
      buildId: generation.buildId,
      totalBytes: generation.totalBytes
    }
  ])
}

/**
 * Opens a generation already on disk under its own route list, or answers `unclaimed` when that list
 * does not carry it. The only judge available when the newer manifest is absent or refused:
 * opening under a bundle this shell is not running would grant the page what other bytes declared.
 *
 * `unclaimed` is the caller's because these bytes say nothing about what the host serves now: the
 * screen the newer manifest would have answered with, never a version wall. `wall` is asked only on
 * the served branch, since it judges bytes that are about to be shown. `patch` belongs to either
 * answer; `served` is what only an opened page gets.
 */
export function openByOwnRoutes(
  session: MobileWebShellSession,
  generation: CachedGeneration,
  options: {
    unclaimed: MobileWebShellSessionState
    patch?: Partial<MobileWebShellSession>
    served?: Partial<MobileWebShellSession>
    wall?: MobileWebShellBlockedVerdict | null
  }
): MobileWebShellStep {
  const { unclaimed, patch = {}, served = {}, wall = null } = options
  const view = {
    ...routeViewOf(generation.routes, session.routePathname, session.wide),
    routes: generation.routes
  }
  if (!rendersRoute(view.pageRoutes, session.routePathname)) {
    return step(session, { ...patch, ...view, state: unclaimed })
  }
  if (wall !== null) {
    return step(session, { ...patch, ...view, state: { kind: 'wall', verdict: wall } })
  }
  return openCached(session, generation, { ...patch, ...served, ...view })
}

type ServedView = Pick<
  MobileWebShellSession,
  'pageRoutes' | 'pageRouteGrants' | 'routeGrants' | 'ownsHostArea' | 'routes'
>

/** Connected cache read: open a compatible generation now, and still ask the host what it serves. */
export function reachableCacheRead(
  session: MobileWebShellSession,
  generation: CachedGeneration | null,
  gates: MobileWebShellGates
): MobileWebShellStep {
  if (
    generation === null ||
    cachedGenerationWall(gateVerdict(gates), gates, generation.compat) !== null
  ) {
    return step(session, { cached: generation, state: CHECKING }, [{ kind: 'read-manifest' }])
  }
  const opened = openByOwnRoutes(session, generation, {
    unclaimed: CHECKING,
    patch: { cached: generation }
  })
  return { ...opened, effects: [...opened.effects, { kind: 'read-manifest' }] }
}

/** Manifest against a cache that may already be opening. Same bytes stay up; a newer build fetches
 *  behind them instead of covering them. */
export function reconcileManifestCache(
  session: MobileWebShellSession,
  manifest: MobileWebShellManifestFacts,
  view: ServedView
): MobileWebShellStep {
  const cached = session.cached
  const activeMatchesManifest =
    session.state.kind === 'ready' && session.state.buildId === manifest.buildId
  if (cached?.buildId === manifest.buildId || activeMatchesManifest) {
    const live = session.state.kind === 'activating' || session.state.kind === 'ready'
    if (live && sameRouteView(view, session)) {
      return step(session, view)
    }
    if (cached !== null) {
      return openCached(session, cached, view)
    }
  }
  const live =
    (cached !== null && session.state.kind === 'activating') || session.state.kind === 'ready'
  if (live) {
    return step(
      session,
      { requestedBuildId: manifest.buildId, offeredRoutes: manifest.routes ?? null },
      [{ kind: 'download' }]
    )
  }
  return step(
    session,
    {
      ...view,
      requestedBuildId: manifest.buildId,
      offeredRoutes: null,
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

function showsCachedGeneration(session: MobileWebShellSession): boolean {
  const cached = session.cached
  if (cached === null) {
    return false
  }
  if (session.state.kind === 'activating' && session.state.source === 'cache') {
    return true
  }
  // A ready page is either the cache or a download that landed behind it; both are newer-or-equal.
  return session.state.kind === 'ready'
}

/** A refused update. A generation already opening stays up; anything else opens or walls as before. */
export function cachedFallback(
  session: MobileWebShellSession,
  cached: CachedGeneration,
  options: {
    unclaimed: MobileWebShellSessionState
    served?: Partial<MobileWebShellSession>
    wall?: MobileWebShellBlockedVerdict | null
  }
): MobileWebShellStep {
  if ((options.wall ?? null) === null && showsCachedGeneration(session)) {
    return step(session, { ...options.served, offeredRoutes: null })
  }
  return openByOwnRoutes(session, cached, { ...options, patch: { offeredRoutes: null } })
}

/** `activated` from either open. A download landing behind a cached page takes the offered routes
 *  with it; a late open of the generation it replaced does not. */
export function generationActivated(
  session: MobileWebShellSession,
  event: {
    generationDirectory: string
    sessionId: string
    buildId: string
    totalBytes: number
    elapsedMs: number
  }
): MobileWebShellStep {
  const cachedBuildId = session.cached?.buildId ?? null
  if (session.state.kind !== 'activating' && session.state.kind !== 'ready') {
    return step(session, {})
  }
  if (
    session.state.kind === 'ready' &&
    cachedBuildId !== null &&
    event.buildId === cachedBuildId &&
    session.state.buildId !== cachedBuildId
  ) {
    return step(session, {})
  }
  const activeBuildId = session.state.kind === 'ready' ? session.state.buildId : cachedBuildId
  const downloadLanded =
    (session.state.kind === 'activating' && session.state.source === 'download') ||
    (session.requestedBuildId !== null &&
      (activeBuildId === null || event.buildId !== activeBuildId))
  const offered =
    downloadLanded && session.offeredRoutes !== null
      ? {
          ...routeViewOf(session.offeredRoutes, session.routePathname, session.wide),
          routes: session.offeredRoutes
        }
      : {}
  const replacingReadyDocument = session.state.kind === 'ready'
  return step(
    session,
    {
      ...(replacingReadyDocument ? { flow: session.flow + 1 } : {}),
      ...CLEAR_PAGE_DOCUMENT_STATE,
      ...offered,
      requestedBuildId: downloadLanded ? null : session.requestedBuildId,
      offeredRoutes: downloadLanded ? null : session.offeredRoutes,
      state: {
        kind: 'ready',
        generationDirectory: event.generationDirectory,
        sessionId: event.sessionId,
        buildId: event.buildId,
        totalBytes: event.totalBytes,
        elapsedMs: event.elapsedMs
      }
    },
    downloadLanded
      ? [{ kind: 'forget-update-failures' }, AWAIT_DOCUMENT_LOAD]
      : [AWAIT_DOCUMENT_LOAD]
  )
}
