import { describe, expect, it } from 'vitest'
import {
  BUNDLE_REFUSED,
  CACHED,
  CACHED_BELOW_HOST_FLOOR,
  LINK_LOST,
  MANIFEST_WIRE,
  afterCacheRead,
  gates,
  manifestFacts,
  run
} from './mobile-web-shell-session-test-fixtures'
import type { MobileWebShellStep } from './mobile-web-shell-session-contract'
import type { MobileWebShellUpdateFailureFacts } from './mobile-web-shell-update-failure'

/**
 * A release build forwards no `console.*` to logcat, so the banner is all a triager gets unless the
 * shell writes down why. Every exit `onDownloadFailed` takes owes exactly one record, carrying what
 * the reducer knew: the cause, the generation offered and the one on disk, and what went on screen.
 */
const NEWER = manifestFacts({ ...MANIFEST_WIRE, buildId: 'c'.repeat(64) })

function recorded(step: MobileWebShellStep): MobileWebShellUpdateFailureFacts[] {
  return step.effects.flatMap((effect) =>
    effect.kind === 'record-update-failure' ? [effect.failure] : []
  )
}

/** Connected, `cached` on disk, NEWER offered, then the gates move to `patch` under the fetch. */
function refusedUnder(
  patch: Parameters<typeof gates>[0],
  cached = CACHED,
  cause = BUNDLE_REFUSED
): MobileWebShellStep {
  const fetching = run(afterCacheRead(cached).session, { type: 'manifest-read', manifest: NEWER })
  const moved = run(fetching.session, { type: 'gates-changed', gates: gates(patch) })
  return run(moved.session, { type: 'download-failed', cause })
}

describe('every exit from a failed update read leaves one record', () => {
  it('nothing on disk: the failure screen, with the offered generation named', () => {
    const fetching = run(afterCacheRead(null).session, { type: 'manifest-read', manifest: NEWER })
    const step = run(fetching.session, { type: 'download-failed', cause: BUNDLE_REFUSED })
    expect(step.session.state).toMatchObject({ kind: 'failed', reason: 'download-failed' })
    expect(recorded(step)).toEqual([
      {
        reason: 'asset-checksum-mismatch',
        hostCode: null,
        offeredBuildId: NEWER.buildId,
        cachedBuildId: null,
        outcome: 'failed',
        wall: null
      }
    ])
  })

  it('the manifest read itself failed: nothing was offered, the cached generation opens', () => {
    const step = run(afterCacheRead(CACHED).session, {
      type: 'download-failed',
      cause: { reason: 'host-refused', hostCode: 'mobile_web_bundle_read_limited' }
    })
    expect(step.session.state).toEqual({ kind: 'activating', source: 'cache' })
    expect(recorded(step)).toEqual([
      {
        reason: 'host-refused',
        hostCode: 'mobile_web_bundle_read_limited',
        offeredBuildId: null,
        cachedBuildId: CACHED.buildId,
        outcome: 'opened-cached',
        wall: null
      }
    ])
  })

  it('a refused download falls back to the cached generation under the notice', () => {
    const step = refusedUnder({})
    expect(step.session.updateNotice).toBe('update-failed')
    expect(recorded(step)).toEqual([
      {
        reason: 'asset-checksum-mismatch',
        hostCode: null,
        offeredBuildId: NEWER.buildId,
        cachedBuildId: CACHED.buildId,
        outcome: 'opened-cached',
        wall: null
      }
    ])
  })

  it('a link that went is recorded too, though the screen carries no notice for it', () => {
    const step = refusedUnder({}, CACHED, LINK_LOST)
    expect(step.session.updateNotice).toBeNull()
    expect(recorded(step)).toMatchObject([{ reason: 'connection-lost', outcome: 'opened-cached' }])
  })

  it('no client to ask is recorded as its own reason', () => {
    const step = refusedUnder({}, CACHED, { reason: 'no-connection', hostCode: null })
    expect(recorded(step)).toMatchObject([{ reason: 'no-connection', outcome: 'opened-cached' }])
  })

  it('a cached generation the host has moved past is walled, and the verdict is kept', () => {
    const step = refusedUnder({}, CACHED_BELOW_HOST_FLOOR)
    expect(step.session.state).toMatchObject({ kind: 'wall' })
    expect(recorded(step)).toMatchObject([
      { outcome: 'wall', wall: 'bundle-too-old-for-host', cachedBuildId: CACHED.buildId }
    ])
  })

  it('a cached generation that never carried this route leaves it native', () => {
    const step = refusedUnder({}, { ...CACHED, routes: [] })
    expect(step.session.state).toEqual({ kind: 'native-route' })
    expect(recorded(step)).toMatchObject([{ outcome: 'native-route', wall: null }])
  })

  it('gates gone offline under the fetch open the cache unjudged', () => {
    const step = refusedUnder({ reachability: 'unreachable' }, CACHED_BELOW_HOST_FLOOR)
    expect(step.session.state).toEqual({ kind: 'activating', source: 'cache' })
    expect(recorded(step)).toMatchObject([{ outcome: 'opened-cached', wall: null }])
  })

  it('gates with an unreadable status answer the status failure', () => {
    const step = refusedUnder({ statusReadable: false })
    expect(step.session.state).toMatchObject({ kind: 'failed', reason: 'status-unreadable' })
    expect(recorded(step)).toMatchObject([{ outcome: 'failed' }])
  })

  it('gates that dropped the bundle capability leave the route native', () => {
    const step = refusedUnder({ hostCapabilities: [] })
    expect(step.session.state).toEqual({ kind: 'native-route' })
    expect(recorded(step)).toMatchObject([{ outcome: 'native-route' }])
  })

  it('gates still dialling or pending leave the session waiting', () => {
    expect(recorded(refusedUnder({ reachability: 'connecting' }))).toMatchObject([
      { outcome: 'waiting' }
    ])
    expect(recorded(refusedUnder({ statusPending: true }))).toMatchObject([{ outcome: 'waiting' }])
  })

  it('a stale flow reports into nothing and records nothing', () => {
    const fetching = run(afterCacheRead(CACHED).session, { type: 'manifest-read', manifest: NEWER })
    const step = run(fetching.session, {
      type: 'download-failed',
      flow: fetching.session.flow - 1,
      cause: BUNDLE_REFUSED
    })
    expect(recorded(step)).toEqual([])
  })

  it('a new flow forgets the generation the last one was offered', () => {
    const fetching = run(afterCacheRead(null).session, { type: 'manifest-read', manifest: NEWER })
    const failed = run(fetching.session, { type: 'download-failed', cause: BUNDLE_REFUSED })
    const retried = run(
      failed.session,
      { type: 'retry-pressed' },
      { type: 'cache-read', generation: CACHED }
    )
    const step = run(retried.session, { type: 'download-failed', cause: LINK_LOST })
    expect(recorded(step)).toMatchObject([{ offeredBuildId: null }])
  })
})

describe('a newer generation committed clears the record, and nothing else does', () => {
  function forgets(step: MobileWebShellStep): boolean {
    return step.effects.some((effect) => effect.kind === 'forget-update-failures')
  }

  function activated(buildId: string) {
    return {
      type: 'activated',
      generationDirectory: '/cache/gen',
      sessionId: 'session-one',
      buildId,
      totalBytes: 1,
      elapsedMs: 1
    } as const
  }

  it('forgets once the offered generation lands', () => {
    const fetching = run(afterCacheRead(CACHED).session, { type: 'manifest-read', manifest: NEWER })
    const step = run(fetching.session, { type: 'download-staged' }, activated(NEWER.buildId))
    expect(step.session.state).toMatchObject({ kind: 'ready', buildId: NEWER.buildId })
    expect(forgets(step)).toBe(true)
  })

  it('forgets when the host moved between the manifest read and the fetch', () => {
    // The fetch reads the manifest again and commits what that read named, so the build that lands
    // can be newer than the one this flow was offered. It is still this download's commit.
    const MOVED = 'd'.repeat(64)
    const fetching = run(afterCacheRead(CACHED).session, { type: 'manifest-read', manifest: NEWER })
    const step = run(fetching.session, { type: 'download-staged' }, activated(MOVED))
    expect(step.session.state).toMatchObject({ kind: 'ready', buildId: MOVED })
    expect(forgets(step)).toBe(true)
  })

  it('keeps the record when the fallback opens the cached generation', () => {
    const fetching = run(afterCacheRead(CACHED).session, { type: 'manifest-read', manifest: NEWER })
    const failed = run(fetching.session, { type: 'download-failed', cause: BUNDLE_REFUSED })
    expect(forgets(run(failed.session, activated(CACHED.buildId)))).toBe(false)
  })

  it('keeps it for a same-build cache hit, which committed nothing', () => {
    const hit = run(afterCacheRead(CACHED).session, {
      type: 'manifest-read',
      manifest: manifestFacts(MANIFEST_WIRE)
    })
    expect(forgets(run(hit.session, activated(CACHED.buildId)))).toBe(false)
  })

  it('keeps it for an offline open', () => {
    const offline = run(
      afterCacheRead(null).session,
      { type: 'gates-changed', gates: gates({ reachability: 'unreachable' }) },
      { type: 'retry-pressed' },
      { type: 'cache-read', generation: CACHED }
    )
    expect(offline.session.state).toEqual({ kind: 'activating', source: 'cache' })
    expect(forgets(run(offline.session, activated(CACHED.buildId)))).toBe(false)
  })
})
