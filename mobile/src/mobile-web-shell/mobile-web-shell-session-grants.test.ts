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
