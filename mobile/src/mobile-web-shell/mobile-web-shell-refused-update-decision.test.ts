import { describe, expect, it } from 'vitest'
import {
  CACHED,
  CACHED_BELOW_HOST_FLOOR,
  MANIFEST_WIRE,
  afterCacheRead,
  gates,
  manifestFacts,
  run,
  BUNDLE_REFUSED,
  withoutRecord
} from './mobile-web-shell-session-test-fixtures'

const DOWNLOAD_FAILED = { kind: 'failed', reason: 'download-failed', retriedOnce: false }

// Refused updates should fall back to intact cached bytes under their own routes/grants, as offline entry does, while respecting any reachable host’s compatibility window.
describe('an update this shell refused falls back to the generation that already works', () => {
  // Change assets and grants so the new manifest cannot safely authorize the old bytes.
  const NEWER = manifestFacts({
    ...MANIFEST_WIRE,
    buildId: 'c'.repeat(64),
    routes: [{ pathname: '/h/[hostId]', grants: ['navigate', 'storage'] }]
  })

  function refused() {
    return run(
      afterCacheRead(CACHED).session,
      { type: 'manifest-read', manifest: NEWER },
      { type: 'download-failed', cause: BUNDLE_REFUSED }
    )
  }

  it('asks for the newer generation before any of this, so the refusal is a real one', () => {
    const fetching = run(afterCacheRead(CACHED).session, { type: 'manifest-read', manifest: NEWER })
    expect(fetching.session.state).toMatchObject({ kind: 'fetching' })
    expect(fetching.effects).toEqual([{ kind: 'download' }])
  })

  it('opens the cached generation rather than walling a host it can still reach', () => {
    const step = refused()
    expect(step.session.updateNotice).toBe('update-failed')
    expect(step.session.state).toEqual({ kind: 'activating', source: 'cache' })
    expect(withoutRecord(step.effects)).toEqual([
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

  it('leaves the refused generation out of the cache and keeps the cached one', () => {
    const step = refused()
    expect(step.session.cached).toEqual(CACHED)
    expect(step.effects.map((effect) => effect.kind)).not.toContain('delete-cache')
  })

  it('still walls when there is no cached generation to fall back to', () => {
    const step = run(afterCacheRead(null).session, {
      type: 'manifest-read',
      manifest: NEWER
    })
    const failed = run(step.session, { type: 'download-failed', cause: BUNDLE_REFUSED })
    expect(failed.session.state).toEqual({
      kind: 'failed',
      reason: 'download-failed',
      retriedOnce: false
    })
    expect(withoutRecord(failed.effects)).toEqual([])
  })

  it('walls the cached generation the host has moved past rather than serving it', () => {
    // Unlike offline fallback, this reachable host can have moved outside the cached bundle’s compatibility window.
    const step = run(
      run(afterCacheRead(CACHED_BELOW_HOST_FLOOR).session, {
        type: 'manifest-read',
        manifest: NEWER
      }).session,
      { type: 'download-failed', cause: BUNDLE_REFUSED }
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
    expect(withoutRecord(step.effects)).toEqual([])
  })

  it('shows the download failure when the cached bundle never carried the route, before any wall', () => {
    // An unclaimed cached route is download failure, not a compat wall, even when those unused bytes are below the host floor.
    const fetching = run(afterCacheRead({ ...CACHED_BELOW_HOST_FLOOR, routes: [] }).session, {
      type: 'manifest-read',
      manifest: NEWER
    })
    const step = run(fetching.session, { type: 'download-failed', cause: BUNDLE_REFUSED })
    expect(step.session.state).toEqual(DOWNLOAD_FAILED)
    expect(step.session.updateNotice).toBeNull()
    expect(withoutRecord(step.effects)).toEqual([])
  })

  it('shows the download failure for a generation from before routes were listed at all', () => {
    // Older cached manifests lack routes and cannot claim this one; do not wall bytes that will not run.
    const fetching = run(
      afterCacheRead({ ...CACHED_BELOW_HOST_FLOOR, routes: undefined }).session,
      { type: 'manifest-read', manifest: NEWER }
    )
    const step = run(fetching.session, { type: 'download-failed', cause: BUNDLE_REFUSED })
    expect(step.session.state).toEqual(DOWNLOAD_FAILED)
  })
})

// Gates can change during fetching; fallback must use their current verdict, including recoverable unreadable status, instead of inventing another decision.
describe('the fallback answers each gate verdict the way the rest of the shell does', () => {
  const NEWER = manifestFacts({ ...MANIFEST_WIRE, buildId: 'c'.repeat(64) })

  function refusedUnder(patch: Parameters<typeof gates>[0], cached = CACHED) {
    const fetching = run(afterCacheRead(cached).session, { type: 'manifest-read', manifest: NEWER })
    const moved = run(fetching.session, { type: 'gates-changed', gates: gates(patch) })
    return run(moved.session, { type: 'download-failed', cause: BUNDLE_REFUSED })
  }

  it('walls the host when it has stopped serving a bundle at all', () => {
    const step = refusedUnder({ hostCapabilities: [] })
    expect(step.session.state).toEqual({
      kind: 'wall',
      verdict: { kind: 'blocked', reason: 'bundle-unavailable' }
    })
    expect(step.session.updateNotice).toBeNull()
    expect(withoutRecord(step.effects)).toEqual([])
  })

  it('says the status could not be read rather than serving a generation it cannot judge', () => {
    const step = refusedUnder({ statusReadable: false, hostCapabilities: [] })
    expect(step.session.state).toEqual({
      kind: 'failed',
      reason: 'status-unreadable',
      retriedOnce: false
    })
    expect(run(step.session, { type: 'gates-changed', gates: gates() }).effects).toEqual([
      { kind: 'open-cache' }
    ])
  })

  it('serves a generation the host can no longer be asked about, compat check and all skipped', () => {
    // Offline fallback skips compatibility checks because no reachable host has stated a newer window.
    const step = refusedUnder({ reachability: 'unreachable' }, CACHED_BELOW_HOST_FLOOR)
    expect(step.session.state).toEqual({ kind: 'activating', source: 'cache' })
    expect(step.session.updateNotice).toBe('update-failed')
  })

  it.each(['connecting' as const])('waits on a dial in progress (%s) rather than deciding', () => {
    const step = refusedUnder({ reachability: 'connecting' })
    expect(step.session.state).toEqual({ kind: 'checking' })
    expect(withoutRecord(step.effects)).toEqual([])
    expect(run(step.session, { type: 'gates-changed', gates: gates() }).effects).toEqual([
      { kind: 'open-cache' }
    ])
  })

  it('waits on a status still pending rather than reading its empty capability list', () => {
    const step = refusedUnder({ statusPending: true, hostCapabilities: [] })
    expect(step.session.state).toEqual({ kind: 'checking' })
    expect(withoutRecord(step.effects)).toEqual([])
  })

  it('judges the generation only on the verdict that leaves a host to judge against', () => {
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
      { type: 'download-failed', cause: BUNDLE_REFUSED }
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
