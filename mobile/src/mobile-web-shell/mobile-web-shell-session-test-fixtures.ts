import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
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
  MobileWebShellSessionEffect,
  MobileWebShellSessionEvent,
  MobileWebShellStep
} from './mobile-web-shell-session-contract'
import type { MobileWebShellUpdateFailureCause } from './mobile-web-shell-update-failure'

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

export const ROUTE = '/h/host-1'
export const PAGE_ROUTES = [{ pathname: '/h/[hostId]', grants: ['navigate'] }]

const MANIFEST_ASSETS: MobileWebBundleManifestRead['assets'] = [
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
]

export const MANIFEST_WIRE: MobileWebBundleManifestRead = {
  schemaVersion: 1,
  buildId: computeMobileWebBundleId(MANIFEST_ASSETS),
  minCompatibleRuntimeProtocolVersion: 2,
  runtimeProtocolVersion: 5,
  pageVersion: 1,
  entrypoint: 'index.html',
  totalBytes: 4096,
  assets: MANIFEST_ASSETS,
  routes: PAGE_ROUTES
}

export const BUNDLE_REFUSED: MobileWebShellUpdateFailureCause = {
  reason: 'asset-checksum-mismatch',
  hostCode: null
}
export const LINK_LOST: MobileWebShellUpdateFailureCause = {
  reason: 'connection-lost',
  hostCode: null
}

// Exclude diagnostic records here; their dedicated suite checks them while these assertions focus on screen/disk effects.
export function withoutRecord(
  effects: readonly MobileWebShellSessionEffect[]
): MobileWebShellSessionEffect[] {
  return effects.filter((effect) => effect.kind !== 'record-update-failure')
}

export function manifestFacts(wire: MobileWebBundleManifestRead): MobileWebShellManifestFacts {
  return {
    buildId: wire.buildId,
    schemaVersion: wire.schemaVersion,
    runtimeProtocolVersion: wire.runtimeProtocolVersion,
    minCompatibleRuntimeProtocolVersion: wire.minCompatibleRuntimeProtocolVersion,
    pageVersion: wire.pageVersion,
    totalBytes: wire.totalBytes,
    totalAssets: wire.assets.length,
    routes: wire.routes
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
    minCompatibleRuntimeProtocolVersion: MANIFEST.minCompatibleRuntimeProtocolVersion,
    pageVersion: MANIFEST.pageVersion
  }
}

export const CACHED_BELOW_HOST_FLOOR: CachedGeneration = {
  ...CACHED,
  compat: { ...CACHED.compat, runtimeProtocolVersion: 0 }
}

// Default result events to the current flow; stale-result tests pin their superseded flow explicitly.
type PendingEvent<E = MobileWebShellSessionEvent> = E extends { flow: number }
  ? Omit<E, 'flow'> & { readonly flow?: number }
  : E

export function stamp(flow: number, event: PendingEvent): MobileWebShellSessionEvent {
  switch (event.type) {
    case 'gates-changed':
    case 'shell-failed':
    case 'retry-pressed':
    case 'document-started':
    case 'document-loaded':
    case 'page-ready':
    case 'page-painted':
    case 'page-back-claim':
    case 'layout-changed':
      return event
    case 'cache-read':
    case 'manifest-read':
    case 'fetch-progress':
    case 'download-staged':
    case 'activated':
    case 'remounted':
    case 'download-failed':
    case 'page-ready-deadline':
    case 'document-load-deadline':
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
