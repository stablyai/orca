/** The reducer's fixtures and drivers, shared by the suites that are split by concern rather than
 *  by subject: one session, one set of gates, and the steps that get it to each state. */
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
export { createMobileWebShellSession } from './mobile-web-shell-session'
import {
  createMobileWebShellSession,
  reduceMobileWebShellSession
} from './mobile-web-shell-session'
import type { MobileWebBundleManifestRead } from '../transport/mobile-web-bundle-reply-schemas'
import type {
  CachedGeneration,
  MobileWebShellGates,
  MobileWebShellManifestFacts,
  MobileWebShellSession,
  MobileWebShellSessionEvent,
  MobileWebShellStep
} from './mobile-web-shell-session-contract'

export function gates(overrides: Partial<MobileWebShellGates> = {}): MobileWebShellGates {
  return {
    statusPending: false,
    statusReadable: true,
    reachability: 'connected',
    hostCapabilities: [MOBILE_WEB_BUNDLE_CAPABILITY],
    hostStatus: { protocolVersion: 10, minCompatibleMobileVersion: 1 },
    ...overrides
  }
}

/** The route every session below is opened for, and the pattern the bundles list it under. */
export const ROUTE = '/h/host-1'
export const PAGE_ROUTES = [{ pathname: '/h/[hostId]', grants: ['navigate'] }]

/** The manifest as the host sends it. Every facts object below is projected from one of these, so a
 *  test that edits the routes cannot leave the projection and the manifest it came from disagreeing
 *  — which is exactly what a same-build persist would then write. */
export const MANIFEST_WIRE: MobileWebBundleManifestRead = {
  schemaVersion: 1,
  buildId: 'b'.repeat(64),
  minCompatibleRuntimeProtocolVersion: 2,
  runtimeProtocolVersion: 5,
  entrypoint: 'index.html',
  totalBytes: 4096,
  assets: [
    {
      path: 'assets/app.js',
      sha256: '1'.repeat(64),
      byteLength: 1024,
      contentType: 'text/javascript'
    },
    { path: 'assets/app.css', sha256: '2'.repeat(64), byteLength: 1024, contentType: 'text/css' },
    {
      path: 'assets/logo.svg',
      sha256: '3'.repeat(64),
      byteLength: 1024,
      contentType: 'image/svg+xml'
    },
    { path: 'index.html', sha256: '4'.repeat(64), byteLength: 1024, contentType: 'text/html' }
  ],
  routes: PAGE_ROUTES
}

export function manifestFacts(wire: MobileWebBundleManifestRead): MobileWebShellManifestFacts {
  return {
    buildId: wire.buildId,
    schemaVersion: wire.schemaVersion,
    runtimeProtocolVersion: wire.runtimeProtocolVersion,
    minCompatibleRuntimeProtocolVersion: wire.minCompatibleRuntimeProtocolVersion,
    totalBytes: wire.totalBytes,
    totalAssets: wire.assets.length,
    routes: wire.routes,
    wire
  }
}

export const MANIFEST: MobileWebShellManifestFacts = manifestFacts(MANIFEST_WIRE)

export const CACHED: CachedGeneration = {
  buildId: MANIFEST.buildId,
  directory: '/cache/mobile-web/host/generations/b',
  totalBytes: 4096,
  routes: PAGE_ROUTES,
  compat: {
    schemaVersion: MANIFEST.schemaVersion,
    runtimeProtocolVersion: MANIFEST.runtimeProtocolVersion,
    minCompatibleRuntimeProtocolVersion: MANIFEST.minCompatibleRuntimeProtocolVersion
  }
}

/** The same generation on disk, declaring something the host it is about to be judged against no
 *  longer accepts. `gates()` answers `minCompatibleMobileVersion: 1`, so a bundle runtime of 0 is
 *  below the floor this host states — which is the usual reason an update exists at all. */
export const CACHED_BELOW_HOST_FLOOR: CachedGeneration = {
  ...CACHED,
  compat: { ...CACHED.compat, runtimeProtocolVersion: 0 }
}

/** An event as a test writes it. An effect result is stamped with the flow the session is on, which
 *  is what an in-order runner does; a test replaying a superseded run pins the flow itself. */
type PendingEvent<E = MobileWebShellSessionEvent> = E extends { flow: number }
  ? Omit<E, 'flow'> & { readonly flow?: number }
  : E

export function stamp(flow: number, event: PendingEvent): MobileWebShellSessionEvent {
  switch (event.type) {
    case 'gates-changed':
    case 'shell-failed':
    case 'retry-pressed':
    case 'document-loaded':
    case 'page-ready':
      return event
    case 'cache-read':
    case 'manifest-read':
    case 'fetch-progress':
    case 'download-staged':
    case 'activated':
    case 'remounted':
    case 'download-failed':
    case 'page-ready-deadline':
      return { ...event, flow: event.flow ?? flow }
  }
}

export function run(
  session: MobileWebShellSession,
  ...events: readonly PendingEvent[]
): MobileWebShellStep {
  let step: MobileWebShellStep = { session, effects: [] }
  for (const event of events) {
    step = reduceMobileWebShellSession(step.session, stamp(step.session.flow, event))
  }
  return step
}

export function started(overrides: Partial<MobileWebShellGates> = {}): MobileWebShellStep {
  return run(createMobileWebShellSession(ROUTE), { type: 'gates-changed', gates: gates(overrides) })
}

/** Connected, capability present, cache read, manifest in flight. */
export function afterCacheRead(generation: CachedGeneration | null): MobileWebShellStep {
  return run(started().session, { type: 'cache-read', generation })
}

export function readySession(): MobileWebShellStep {
  return run(
    afterCacheRead(CACHED).session,
    { type: 'manifest-read', manifest: MANIFEST },
    {
      type: 'activated',
      generationDirectory: CACHED.directory,
      sessionId: 'session-one',
      buildId: MANIFEST.buildId,
      totalBytes: MANIFEST.totalBytes,
      elapsedMs: 12
    }
  )
}

/** The second half of a recovery: the refetch the delete queued, through to a mounted view. */
export function readyAgain(session: MobileWebShellSession, sessionId: string): MobileWebShellStep {
  return run(
    session,
    { type: 'cache-read', generation: null },
    { type: 'manifest-read', manifest: MANIFEST },
    { type: 'download-staged' },
    {
      type: 'activated',
      generationDirectory: '/cache/gen',
      sessionId,
      buildId: MANIFEST.buildId,
      totalBytes: MANIFEST.totalBytes,
      elapsedMs: 7
    }
  )
}
