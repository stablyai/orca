import { describe, expect, it } from 'vitest'
import type {
  CachedGeneration,
  MobileWebShellManifestFacts
} from './mobile-web-shell-session-contract'
import {
  CACHED,
  MANIFEST,
  MANIFEST_WIRE,
  PAGE_ROUTES,
  afterCacheRead,
  manifestFacts,
  run,
  LINK_LOST
} from './mobile-web-shell-session-test-fixtures'

// Fallback must restore cached routes/grants; the replacement manifest must not grant old bytes capabilities they never declared.
describe('falling back to the cached generation after a failed download', () => {
  const cachedOnlyNavigate: CachedGeneration = { ...CACHED, routes: PAGE_ROUTES }
  // Use a distinct build id to force download instead of the same-build cache path.
  const manifestWithClipboard: MobileWebShellManifestFacts = manifestFacts({
    ...MANIFEST_WIRE,
    buildId: 'd'.repeat(64),
    routes: [{ pathname: '/h/[hostId]', grants: ['navigate', 'native.clipboard.read'] }]
  })

  it('opens it under its own grants, not the ones the newer manifest declared', () => {
    const fetching = run(afterCacheRead(cachedOnlyNavigate).session, {
      type: 'manifest-read',
      manifest: manifestWithClipboard
    })
    expect([...fetching.session.routeGrants]).toEqual(['navigate', 'native.clipboard.read'])
    const step = run(fetching.session, { type: 'download-failed', cause: LINK_LOST })
    expect(step.session.state.kind).toBe('activating')
    expect([...step.session.routeGrants]).toEqual(['navigate'])
  })

  it('carries a verb declared in the manifest through to the session grants', () => {
    const step = run(afterCacheRead(null).session, {
      type: 'manifest-read',
      manifest: manifestFacts({
        ...MANIFEST_WIRE,
        routes: [{ pathname: '/h/[hostId]', grants: ['navigate', 'native.clipboard.write'] }]
      })
    })
    expect([...step.session.routeGrants]).toEqual(['navigate', 'native.clipboard.write'])
  })
})

// Carry pageRouteGrants through downloads too; otherwise first installs/updates treat every target as unpaired and hand all hops to native.
describe('the route grants a downloaded generation is activated under', () => {
  const TWO_ROUTES = [
    { pathname: '/h/[hostId]', grants: ['navigate', 'storage'] },
    { pathname: '/h/[hostId]/tasks', grants: ['navigate', 'native.clipboard.write'] }
  ]
  const DOWNLOADED: MobileWebShellManifestFacts = manifestFacts({
    ...MANIFEST_WIRE,
    buildId: 'c'.repeat(64),
    routes: TWO_ROUTES
  })

  function activate(session: Parameters<typeof run>[0], manifest: MobileWebShellManifestFacts) {
    return run(
      session,
      { type: 'manifest-read', manifest },
      { type: 'download-staged' },
      {
        type: 'activated',
        generationDirectory: '/cache/gen',
        sessionId: 'session-downloaded',
        buildId: manifest.buildId,
        totalBytes: manifest.totalBytes,
        elapsedMs: 9
      }
    )
  }

  it('is the manifest it downloaded, on a cold cache', () => {
    const step = activate(afterCacheRead(null).session, DOWNLOADED)
    expect(step.session.state.kind).toBe('ready')
    expect(step.session.pageRouteGrants).toEqual(TWO_ROUTES)
  })

  it('is the manifest it matched, on a cached hit', () => {
    const step = run(afterCacheRead(CACHED).session, { type: 'manifest-read', manifest: MANIFEST })
    expect(step.session.state.kind).toBe('activating')
    expect(step.session.pageRouteGrants).toEqual(PAGE_ROUTES)
  })

  it("replaces the previous generation's entries when the generation changes", () => {
    // Seed older pairs so a missed update exposes stale grants as well as empty defaults.
    const first = run(afterCacheRead(CACHED).session, { type: 'manifest-read', manifest: MANIFEST })
    expect(first.session.pageRouteGrants).toEqual(PAGE_ROUTES)
    const step = activate(
      run(first.session, { type: 'retry-pressed' }, { type: 'cache-read', generation: CACHED })
        .session,
      DOWNLOADED
    )
    expect(step.session.pageRouteGrants).toEqual(TWO_ROUTES)
  })
})
