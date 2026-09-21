import { describe, expect, it } from 'vitest'
import type {
  CachedGeneration,
  MobileWebShellManifestFacts
} from './mobile-web-shell-session-contract'
import {
  CACHED,
  MANIFEST,
  PAGE_ROUTES,
  afterCacheRead,
  run
} from './mobile-web-shell-session-test-fixtures'

/**
 * A download that failed falls back to the generation on disk, and that generation's routes are
 * what it must be judged by — including its grants.
 *
 * The newer manifest is read before the download is attempted, so without this the session keeps
 * the newer bundle's grants and opens the older page under them: a cached route that never
 * declared the clipboard would be granted it by a manifest it is not running.
 */
describe('falling back to the cached generation after a failed download', () => {
  const cachedOnlyNavigate: CachedGeneration = { ...CACHED, routes: PAGE_ROUTES }
  const manifestWithClipboard: MobileWebShellManifestFacts = {
    ...MANIFEST,
    routes: [{ pathname: '/h/[hostId]', grants: ['navigate', 'native.clipboard.read'] }]
  }

  it('opens it under its own grants, not the ones the newer manifest declared', () => {
    const step = run(
      afterCacheRead(cachedOnlyNavigate).session,
      { type: 'manifest-read', manifest: manifestWithClipboard },
      { type: 'download-failed', failure: 'transport' }
    )
    expect(step.session.state.kind).toBe('activating')
    expect([...step.session.routeGrants]).toEqual(['navigate'])
  })

  it('carries a verb declared in the manifest through to the session grants', () => {
    // The whole path a verb takes before a page can call one: the desktop's manifest contract
    // admits the name, the phone's reader keeps it, and the route policy grants it because this
    // build implements it.
    const step = run(afterCacheRead(null).session, {
      type: 'manifest-read',
      manifest: {
        ...MANIFEST,
        routes: [{ pathname: '/h/[hostId]', grants: ['navigate', 'native.clipboard.write'] }]
      }
    })
    expect([...step.session.routeGrants]).toEqual(['navigate', 'native.clipboard.write'])
  })

  it('had the newer grants before the download failed, so the case discriminates', () => {
    const step = run(afterCacheRead(cachedOnlyNavigate).session, {
      type: 'manifest-read',
      manifest: manifestWithClipboard
    })
    expect([...step.session.routeGrants]).toEqual(['navigate', 'native.clipboard.read'])
  })
})

/**
 * The route/grant pairs the page is told about must survive the download path, not only the two
 * paths that open a generation already on disk.
 *
 * `init.pageRouteGrants` is how the page decides an in-page hop is covered. A session that reaches
 * `ready` without them carries the default (or the previous generation's), the page reads every
 * target as listed-with-no-entry, and hands every hop to the shell. That is the first install and
 * every update after it.
 */
describe('the route grants a downloaded generation is activated under', () => {
  const TWO_ROUTES = [
    { pathname: '/h/[hostId]', grants: ['navigate', 'storage'] },
    { pathname: '/h/[hostId]/tasks', grants: ['navigate', 'native.clipboard.write'] }
  ]
  const DOWNLOADED: MobileWebShellManifestFacts = {
    ...MANIFEST,
    buildId: 'c'.repeat(64),
    routes: TWO_ROUTES
  }

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
    // The session already holds the older bundle's pairs, so the assertion fails on a stale field
    // rather than only on the empty default.
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
