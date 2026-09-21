/** The reducer's fixtures and drivers, shared by the suites that are split by concern rather than
 *  by subject: one session, one set of gates, and the steps that get it to each state. */
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
export { createMobileWebShellSession } from './mobile-web-shell-session'
import {
  createMobileWebShellSession,
  reduceMobileWebShellSession
} from './mobile-web-shell-session'
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

export const MANIFEST: MobileWebShellManifestFacts = {
  buildId: 'b'.repeat(64),
  schemaVersion: 1,
  runtimeProtocolVersion: 5,
  minCompatibleRuntimeProtocolVersion: 2,
  totalBytes: 4096,
  totalAssets: 4,
  routes: PAGE_ROUTES
}

export const CACHED: CachedGeneration = {
  buildId: MANIFEST.buildId,
  directory: '/cache/mobile-web/host/generations/b',
  totalBytes: 4096,
  routes: PAGE_ROUTES
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
