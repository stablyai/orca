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

  it('leaves the route native when the cached bundle never carried it, before any wall', () => {
    // The order `onManifestRead` takes, and the one the compat wall broke: a route this bundle
    // does not serve is not a screen to refuse. Below the host's floor as well, so the only thing
    // that can produce `native-route` here is the route question being asked first.
    const fetching = run(afterCacheRead({ ...CACHED_BELOW_HOST_FLOOR, routes: [] }).session, {
      type: 'manifest-read',
      manifest: NEWER
    })
    const step = run(fetching.session, { type: 'download-failed', failure: 'bundle' })
    expect(step.session.state).toEqual({ kind: 'native-route' })
    expect(step.session.updateNotice).toBeNull()
    expect(step.effects).toEqual([])
  })

  it('leaves it native for a generation from before routes were listed at all', () => {
    // `routes: undefined` is every generation cached by a desktop older than the field. It claims
    // no route, so it cannot claim this one, and it must not be walled for that.
    const fetching = run(
      afterCacheRead({ ...CACHED_BELOW_HOST_FLOOR, routes: undefined }).session,
      { type: 'manifest-read', manifest: NEWER }
    )
    const step = run(fetching.session, { type: 'download-failed', failure: 'bundle' })
    expect(step.session.state).toEqual({ kind: 'native-route' })
  })
})

/**
 * What the gates say at the moment of the refusal, and the one answer the shell has for each.
 *
 * Gates that change while the download is in flight are stored without restarting it — a `fetching`
 * session does not await them — so by the time the refusal lands they may say something the flow
 * never started under. Every one of these is a verdict the shell already answers somewhere, and the
 * fallback has to give the same answer rather than a second opinion: walling a host whose status
 * simply went unreadable is the `bundle-unavailable` wall the gate was built to prevent.
 */
describe('the fallback answers each gate verdict the way the rest of the shell does', () => {
  const NEWER = manifestFacts({ ...MANIFEST_WIRE, buildId: 'c'.repeat(64) })

  /** Refused while the gates have since become whatever `patch` says. */
  function refusedUnder(patch: Parameters<typeof gates>[0], cached = CACHED) {
    const fetching = run(afterCacheRead(cached).session, { type: 'manifest-read', manifest: NEWER })
    const moved = run(fetching.session, { type: 'gates-changed', gates: gates(patch) })
    return run(moved.session, { type: 'download-failed', failure: 'bundle' })
  }

  it('answers native-route when the host has stopped serving a bundle at all', () => {
    // Not a wall and not the cached page: a desktop that ships no bundle declares no page route,
    // so this route is the native screen's, which is what `gateVerdict` answers everywhere else.
    const step = refusedUnder({ hostCapabilities: [] })
    expect(step.session.state).toEqual({ kind: 'native-route' })
    expect(step.session.updateNotice).toBeNull()
    expect(step.effects).toEqual([])
  })

  it('says the status could not be read rather than serving a generation it cannot judge', () => {
    const step = refusedUnder({ statusReadable: false, hostCapabilities: [] })
    expect(step.session.state).toEqual({
      kind: 'failed',
      reason: 'status-unreadable',
      retriedOnce: false
    })
    // Recoverable, exactly as a cold entry on the same gates is: a readable status re-arms it.
    expect(run(step.session, { type: 'gates-changed', gates: gates() }).effects).toEqual([
      { kind: 'open-cache' }
    ])
  })

  it('serves a generation the host can no longer be asked about, compat check and all skipped', () => {
    // The offline rule, and the one arm where a below-floor generation is still opened: a host
    // nobody can reach cannot have moved past it, because nothing has been heard from it.
    const step = refusedUnder({ reachability: 'unreachable' }, CACHED_BELOW_HOST_FLOOR)
    expect(step.session.state).toEqual({ kind: 'activating' })
    expect(step.session.updateNotice).toBe('update-failed')
  })

  it.each(['connecting' as const])('waits on a dial in progress (%s) rather than deciding', () => {
    const step = refusedUnder({ reachability: 'connecting' })
    expect(step.session.state).toEqual({ kind: 'checking' })
    expect(step.effects).toEqual([])
    // And the settled gate picks it back up, which `fetching` would never have done.
    expect(run(step.session, { type: 'gates-changed', gates: gates() }).effects).toEqual([
      { kind: 'open-cache' }
    ])
  })

  it('waits on a status still pending rather than reading its empty capability list', () => {
    const step = refusedUnder({ statusPending: true, hostCapabilities: [] })
    expect(step.session.state).toEqual({ kind: 'checking' })
    expect(step.effects).toEqual([])
  })

  it('judges the generation only on the verdict that leaves a host to judge against', () => {
    // `open` is that verdict, and it is the only one that reaches the compat check.
    const step = refusedUnder({}, CACHED_BELOW_HOST_FLOOR)
    expect(step.session.state).toMatchObject({ kind: 'wall' })
  })
})

describe('an update this shell refused, once it is on screen', () => {
  const NEWER = manifestFacts({ ...MANIFEST_WIRE, buildId: 'c'.repeat(64) })

  function refused() {
    return run(
      afterCacheRead(CACHED).session,
      { type: 'manifest-read', manifest: NEWER },
      { type: 'download-failed', failure: 'bundle' }
    )
  }

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
