import { describe, expect, it } from 'vitest'
import type { CachedGeneration } from './mobile-web-shell-session-contract'
import {
  CACHED,
  MANIFEST_WIRE,
  PAGE_ROUTES,
  ROUTE,
  afterCacheRead,
  createMobileWebShellSession,
  gates,
  manifestFacts,
  run
} from './mobile-web-shell-session-test-fixtures'

/** The route listed needing a grant this shell has no answer for, so it is the native screen's.
 *  Either side of the edit can be the one that says this: an older list this build could not serve,
 *  or a newer one that asks for more than it did. */
const UNSERVED_ROUTES = [{ pathname: '/h/[hostId]', grants: ['navigate', 'teleport'] }]
const STALE: CachedGeneration = { ...CACHED, routes: UNSERVED_ROUTES }
const FRESH = manifestFacts({ ...MANIFEST_WIRE, routes: PAGE_ROUTES })

/**
 * A route-grant edit on the desktop moves no asset, so the bundle's build id does not move either.
 * The session reads the fresh routes off the manifest and opens the cached generation, but the
 * manifest stored beside those assets is the edit before — and that stored one is what an
 * unreachable host is judged by. Without a write-through, every offline verdict lags a grant edit.
 */
describe('a same-build manifest read over a cached generation', () => {
  it('opens the cached generation and persists the manifest beside it', () => {
    const step = run(afterCacheRead(STALE).session, { type: 'manifest-read', manifest: FRESH })

    expect(step.session.state).toEqual({ kind: 'activating' })
    expect(step.effects).toEqual([
      {
        kind: 'open-generation',
        directory: CACHED.directory,
        buildId: CACHED.buildId,
        totalBytes: CACHED.totalBytes
      },
      { kind: 'persist-manifest', manifest: FRESH.wire }
    ])
  })

  it('carries the fresh routes on the generation it holds, so a later read in this process agrees', () => {
    const step = run(afterCacheRead(STALE).session, { type: 'manifest-read', manifest: FRESH })

    expect(step.session.cached?.routes).toEqual(PAGE_ROUTES)
    expect(step.session.routeGrants).toEqual(['navigate'])
  })

  it('persists nothing when the cached build is a different one, and fetches instead', () => {
    const otherBuild: CachedGeneration = { ...STALE, buildId: 'c'.repeat(64) }

    const step = run(afterCacheRead(otherBuild).session, { type: 'manifest-read', manifest: FRESH })

    expect(step.effects).toEqual([{ kind: 'download' }])
    expect(step.session.cached?.routes).toEqual(UNSERVED_ROUTES)
  })

  it('persists nothing when there is no generation to persist onto', () => {
    const step = run(afterCacheRead(null).session, { type: 'manifest-read', manifest: FRESH })

    expect(step.effects).toEqual([{ kind: 'download' }])
  })
})

/**
 * The verdict the persist exists for: a later entry into the route with the host gone, judged by
 * the routes the fresh manifest declared rather than the ones the assets were downloaded with.
 *
 * A separate session, because that is the only way this is reached: an `activating` or `ready`
 * session is never restarted by a reachability change, so the offline read belongs to the next
 * mount of the route — the one whose whole evidence is what is on disk.
 */
describe('the offline entry after a same-build manifest was persisted', () => {
  /** The manifest the online read asked the store to write, as a generation read back off disk. */
  function persistedGeneration(): CachedGeneration {
    const online = run(afterCacheRead(STALE).session, { type: 'manifest-read', manifest: FRESH })
    const written = online.effects.flatMap((effect) =>
      effect.kind === 'persist-manifest' ? [effect.manifest] : []
    )
    expect(written).toEqual([FRESH.wire])
    return { ...CACHED, routes: written[0]?.routes }
  }

  function offlineEntry(generation: CachedGeneration) {
    const started = run(createMobileWebShellSession(ROUTE), {
      type: 'gates-changed',
      gates: gates({ reachability: 'unreachable' })
    })
    expect(started.effects).toEqual([{ kind: 'open-cache' }])
    return run(started.session, { type: 'cache-read', generation })
  }

  it('opens the route only the fresh grants allow', () => {
    const step = offlineEntry(persistedGeneration())

    expect(step.session.state).toEqual({ kind: 'activating' })
    expect(step.effects).toEqual([
      {
        kind: 'open-generation',
        directory: CACHED.directory,
        buildId: CACHED.buildId,
        totalBytes: CACHED.totalBytes
      }
    ])
    expect(step.session.routeGrants).toEqual(['navigate'])
  })

  it('leaves it native on the manifest the assets were downloaded with', () => {
    // The discriminator: the same entry against the stored manifest nothing rewrote, which is what
    // every offline verdict was judged by before the write-through.
    const step = offlineEntry(STALE)

    expect(step.session.state).toEqual({ kind: 'native-route' })
    expect(step.session.pageRoutes).toEqual([])
  })
})

/**
 * The verdict about this route is not a verdict about the manifest.
 *
 * A same-build read is the truth about the bundle on disk however this route turns out: the fresh
 * list may take this screen native or name a bundle this shell cannot open, and still grant or
 * revoke another route the same generation serves. Refusing to write it there is how an offline
 * entry keeps grants a desktop has already taken away.
 */
describe('a same-build manifest whose route verdict is not a page', () => {
  it('persists the manifest that takes this route native', () => {
    const fresh = manifestFacts({ ...MANIFEST_WIRE, routes: UNSERVED_ROUTES })

    const step = run(afterCacheRead(CACHED).session, { type: 'manifest-read', manifest: fresh })

    expect(step.session.state).toEqual({ kind: 'native-route' })
    expect(step.effects).toEqual([{ kind: 'persist-manifest', manifest: fresh.wire }])
    expect(step.session.cached?.routes).toEqual(UNSERVED_ROUTES)
  })

  it('persists nothing of a manifest it walls, and holds the routes it can still use', () => {
    // The one same-build read that must not be written: disk holds the last manifest this shell
    // accepted, and an offline entry skips the compat check. Writing a manifest this shell just
    // walled would have the next offline entry open a page under the grants of a bundle it had
    // declared it cannot read.
    const twoRoutes = [
      { pathname: '/h/[hostId]', grants: ['navigate'] },
      { pathname: '/h/[hostId]/tasks', grants: ['navigate'] }
    ]
    const fresh = manifestFacts({ ...MANIFEST_WIRE, schemaVersion: 99, routes: twoRoutes })

    const step = run(afterCacheRead(CACHED).session, { type: 'manifest-read', manifest: fresh })

    expect(step.session.state).toMatchObject({ kind: 'wall' })
    expect(step.effects).toEqual([])
    expect(step.session.cached?.routes).toEqual(PAGE_ROUTES)
  })

  it('persists nothing for another build that takes this route native', () => {
    const otherBuild: CachedGeneration = { ...CACHED, buildId: 'c'.repeat(64) }
    const fresh = manifestFacts({ ...MANIFEST_WIRE, routes: UNSERVED_ROUTES })

    const step = run(afterCacheRead(otherBuild).session, { type: 'manifest-read', manifest: fresh })

    expect(step.session.state).toEqual({ kind: 'native-route' })
    expect(step.effects).toEqual([])
    expect(step.session.cached?.routes).toEqual(PAGE_ROUTES)
  })

  it('persists nothing and fetches nothing for another build that walls', () => {
    const otherBuild: CachedGeneration = { ...CACHED, buildId: 'c'.repeat(64) }
    const fresh = manifestFacts({ ...MANIFEST_WIRE, schemaVersion: 99 })

    const step = run(afterCacheRead(otherBuild).session, { type: 'manifest-read', manifest: fresh })

    expect(step.session.state).toMatchObject({ kind: 'wall' })
    expect(step.effects).toEqual([])
    expect(step.session.cached?.routes).toEqual(PAGE_ROUTES)
  })
})
