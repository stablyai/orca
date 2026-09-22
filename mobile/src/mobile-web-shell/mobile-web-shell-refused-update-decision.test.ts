import { describe, expect, it } from 'vitest'
import {
  CACHED,
  CACHED_BELOW_HOST_FLOOR,
  MANIFEST_WIRE,
  afterCacheRead,
  gates,
  manifestFacts,
  run
} from './mobile-web-shell-session-test-fixtures'

/**
 * The host is up, it serves a generation this shell could not take, and one that works is on disk.
 *
 * Refusing the new bytes is right — a truncated asset does not hash, and a host that will not say
 * what it serves has not been read. What was wrong was the screen that followed: a wall with a
 * "Try again" over an intact workspace the offline path would have opened without being asked.
 * Falling back here is the same branch the unreachable host takes, so the generation is judged by
 * its own route list rather than by the manifest it was about to be replaced from.
 */
describe('an update this shell refused falls back to the generation that already works', () => {
  /** The newer generation the host serves: different bytes, so a different id, and a route-grant
   *  edit beside them that only the bundle carrying it may be run under. */
  const NEWER = manifestFacts({
    ...MANIFEST_WIRE,
    buildId: 'c'.repeat(64),
    routes: [{ pathname: '/h/[hostId]', grants: ['navigate', 'storage'] }]
  })

  /** Connected, N on disk, N+1 read and asked for, and its fetch refused. */
  function refused() {
    return run(
      afterCacheRead(CACHED).session,
      { type: 'manifest-read', manifest: NEWER },
      { type: 'download-failed', failure: 'bundle' }
    )
  }

  it('asks for the newer generation before any of this, so the refusal is a real one', () => {
    const fetching = run(afterCacheRead(CACHED).session, { type: 'manifest-read', manifest: NEWER })
    expect(fetching.session.state).toMatchObject({ kind: 'fetching' })
    expect(fetching.effects).toEqual([{ kind: 'download' }])
  })

  it('opens the cached generation rather than walling a host it can still reach', () => {
    const step = refused()
    expect(step.session.state).toEqual({ kind: 'activating' })
    expect(step.effects).toEqual([
      {
        kind: 'open-generation',
        directory: CACHED.directory,
        buildId: CACHED.buildId,
        totalBytes: CACHED.totalBytes
      }
    ])
  })

  it('runs it under its own grants, not the ones the refused manifest declared', () => {
    expect(refused().session.routeGrants).toEqual(['navigate'])
  })

  it('names the refusal as a notice beside the workspace, not as a state in front of it', () => {
    const ready = run(refused().session, {
      type: 'activated',
      generationDirectory: CACHED.directory,
      sessionId: 'session-one',
      buildId: CACHED.buildId,
      totalBytes: CACHED.totalBytes,
      elapsedMs: 8
    })
    expect(ready.session.state).toMatchObject({ kind: 'ready', buildId: CACHED.buildId })
    expect(ready.session.updateNotice).toBe('update-failed')
  })

  it('leaves the refused generation out of the cache and writes nothing beside it', () => {
    const step = refused()
    expect(step.session.cached).toEqual(CACHED)
    expect(step.effects.map((effect) => effect.kind)).not.toContain('persist-manifest')
    expect(step.effects.map((effect) => effect.kind)).not.toContain('delete-cache')
  })

  it('still walls when there is no cached generation to fall back to', () => {
    const step = run(afterCacheRead(null).session, {
      type: 'manifest-read',
      manifest: NEWER
    })
    const failed = run(step.session, { type: 'download-failed', failure: 'bundle' })
    expect(failed.session.state).toEqual({
      kind: 'failed',
      reason: 'download-failed',
      retriedOnce: false
    })
    expect(failed.effects).toEqual([])
  })

  it('walls the cached generation the host has moved past rather than serving it', () => {
    // The hole the fallback opened. The offline branch skips the compat check because a host
    // nobody can reach cannot have changed; this host answered, and an update usually exists
    // precisely because it moved. Serving these bytes would run the page outside the protocol
    // window the host it is talking to states.
    const step = run(
      run(afterCacheRead(CACHED_BELOW_HOST_FLOOR).session, {
        type: 'manifest-read',
        manifest: NEWER
      }).session,
      { type: 'download-failed', failure: 'bundle' }
    )
    expect(step.session.state).toEqual({
      kind: 'wall',
      verdict: {
        kind: 'blocked',
        reason: 'bundle-incompatible',
        side: 'mobile',
        bundleRuntimeProtocolVersion: 0,
        requiredBundleRuntimeProtocolVersion: 1
      }
    })
    // The wall, not the download-failed screen: what is wrong is the bundle against this host, and
    // "Try again" would re-run a refusal that is not about the link.
    expect(step.effects).toEqual([])
  })

  it('serves the generation that is still inside the window, which is the case above inverted', () => {
    expect(refused().session.state).toEqual({ kind: 'activating' })
    expect(refused().session.updateNotice).toBe('update-failed')
  })

  it.each([
    ['a status nobody could read', { statusReadable: false, hostCapabilities: [] }],
    ['a host that stopped serving a bundle', { hostCapabilities: [] }]
  ] as const)('does not wall on %s, which says nothing about a protocol window', (_name, patch) => {
    // Both leave the capability list empty, and that question is the gate's, with its own answer.
    // Walling here would be the `bundle-unavailable` wall the gate exists to keep off a host that
    // simply did not answer.
    const fetching = run(afterCacheRead(CACHED_BELOW_HOST_FLOOR).session, {
      type: 'manifest-read',
      manifest: NEWER
    })
    const stale = run(fetching.session, { type: 'gates-changed', gates: gates(patch) })
    const step = run(stale.session, { type: 'download-failed', failure: 'bundle' })
    expect(step.session.state).toEqual({ kind: 'activating' })
  })

  it('tries the update again on the next run of the flow, and drops the notice with it', () => {
    const retried = run(refused().session, { type: 'retry-pressed' })
    expect(retried.session.updateNotice).toBeNull()
    expect(retried.effects).toEqual([{ kind: 'open-cache' }])
    const again = run(retried.session, { type: 'cache-read', generation: CACHED })
    expect(again.effects).toEqual([{ kind: 'read-manifest' }])
    expect(run(again.session, { type: 'manifest-read', manifest: NEWER }).effects).toEqual([
      { kind: 'download' }
    ])
  })

  it('drops the notice the moment the flow runs again, before anything is known again', () => {
    const served = run(refused().session, {
      type: 'activated',
      generationDirectory: CACHED.directory,
      sessionId: 'session-one',
      buildId: CACHED.buildId,
      totalBytes: CACHED.totalBytes,
      elapsedMs: 8
    })
    const dropped = run(served.session, { type: 'shell-failed', reason: 'document-load-failed' })
    expect(dropped.session.updateNotice).toBeNull()
  })
})
