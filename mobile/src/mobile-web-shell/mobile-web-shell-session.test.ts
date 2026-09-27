import { describe, expect, it } from 'vitest'
import {
  createMobileWebShellSession,
  readyAgain,
  CACHED,
  MANIFEST,
  ROUTE,
  afterCacheRead,
  gates,
  readySession,
  run,
  started,
  BUNDLE_REFUSED,
  LINK_LOST,
  withoutRecord
} from './mobile-web-shell-session-test-fixtures'
import { BRIDGE_PAGE_PAINTED } from './bridge/bridge-page-painted'
import { shellPageFrame } from './shell-page-frame'

describe('the gates decide whether a step is taken at all', () => {
  it('waits while a connection is still being made', () => {
    const step = started({ reachability: 'connecting' })
    expect(step.session.state).toEqual({ kind: 'checking' })
    expect(step.effects).toEqual([])
  })

  it('waits while status.get is still pending rather than reading its empty capabilities', () => {
    const step = started({ statusPending: true, hostCapabilities: [] })
    expect(step.session.state).toEqual({ kind: 'checking' })
    expect(step.effects).toEqual([])
  })

  it('says a status could not be read rather than walling or waiting on it forever', () => {
    const step = started({ statusReadable: false, hostCapabilities: [] })
    expect(step.session.state).toEqual({
      kind: 'failed',
      reason: 'status-unreadable',
      retriedOnce: false
    })
    expect(step.effects).toEqual([])
  })

  it('picks the flow back up if that status ever becomes readable', () => {
    const unreadable = started({ statusReadable: false, hostCapabilities: [] })
    const step = run(unreadable.session, { type: 'gates-changed', gates: gates() })
    expect(step.session.state).toEqual({ kind: 'checking' })
    expect(step.effects).toEqual([{ kind: 'open-cache' }])
  })

  it('leaves the route native for a readable host that serves no bundle', () => {
    // Not a wall: a wall says the workspace cannot be opened, and a desktop with no bundle declares
    // no page route, so there is nothing to open and the native screen is where this already was.
    const step = started({ hostCapabilities: [] })
    expect(step.session.state).toEqual({ kind: 'native-route' })
    expect(step.effects).toEqual([])
  })

  it('sweeps and reads the cache once the capability is answered', () => {
    expect(started().effects).toEqual([{ kind: 'open-cache' }])
  })

  it('reads the cache for an unreachable host too, before deciding anything', () => {
    expect(started({ reachability: 'unreachable' }).effects).toEqual([{ kind: 'open-cache' }])
  })
})

describe('the offline rule', () => {
  it('leaves an unreachable host native when its cached bundle lists no such route', () => {
    const offline = started({ reachability: 'unreachable' })
    const step = run(offline.session, {
      type: 'cache-read',
      generation: { ...CACHED, routes: [] }
    })
    expect(step.session.state).toEqual({ kind: 'native-route' })
    expect(step.effects).toEqual([])
  })

  it('opens a cached generation with no compat check when the host is unreachable', () => {
    const start = started({ reachability: 'unreachable', hostCapabilities: [] })
    const step = run(start.session, { type: 'cache-read', generation: CACHED })
    expect(step.session.state).toEqual({ kind: 'activating', source: 'cache' })
    expect(step.effects).toEqual([
      {
        kind: 'open-generation',
        directory: CACHED.directory,
        buildId: CACHED.buildId,
        totalBytes: CACHED.totalBytes
      }
    ])
  })

  it('says so when an unreachable host has nothing cached', () => {
    const start = started({ reachability: 'unreachable' })
    const step = run(start.session, { type: 'cache-read', generation: null })
    expect(step.session.state).toEqual({ kind: 'offline' })
    expect(step.effects).toEqual([])
  })

  it('waits on a cache read that lands mid-dial instead of opening it unchecked', () => {
    const dialling = run(started().session, {
      type: 'gates-changed',
      gates: gates({ reachability: 'connecting' })
    })
    const step = run(dialling.session, { type: 'cache-read', generation: CACHED })
    // Connecting is not unreachable: the compat check is a moment away, and skipping it would put a
    // generation on screen the host is about to say it no longer serves.
    expect(step.session.state).toEqual({ kind: 'checking' })
    expect(step.session.cached).toEqual(CACHED)
    expect(step.effects).toEqual([])
  })

  it('restarts the flow when the host becomes reachable while offline is showing', () => {
    const offline = run(started({ reachability: 'unreachable' }).session, {
      type: 'cache-read',
      generation: null
    })
    const step = run(offline.session, { type: 'gates-changed', gates: gates() })
    expect(step.effects).toEqual([{ kind: 'open-cache' }])
  })
})

describe('the connected flow', () => {
  it('asks the host for a manifest once the cache has been read', () => {
    expect(afterCacheRead(null).effects).toEqual([{ kind: 'read-manifest' }])
    expect(afterCacheRead(CACHED).effects).toEqual([{ kind: 'read-manifest' }])
  })

  it('walls a manifest written in a schema this shell does not know', () => {
    const step = run(afterCacheRead(null).session, {
      type: 'manifest-read',
      manifest: { ...MANIFEST, schemaVersion: 99 }
    })
    expect(step.session.state).toEqual({
      kind: 'wall',
      verdict: { kind: 'blocked', reason: 'bundle-shell-too-old', schemaVersion: 99 }
    })
    expect(step.effects).toEqual([])
  })

  it('opens the cached generation without paging when the build ids match', () => {
    const step = run(afterCacheRead(CACHED).session, { type: 'manifest-read', manifest: MANIFEST })
    expect(step.session.state).toEqual({ kind: 'activating', source: 'cache' })
    // And it writes the manifest it just matched: the routes are the only thing a same-build read
    // can have changed, and nothing else on this path touches the disk.
    expect(step.effects).toEqual([
      {
        kind: 'open-generation',
        directory: CACHED.directory,
        buildId: CACHED.buildId,
        totalBytes: CACHED.totalBytes
      },
      { kind: 'persist-manifest', manifest: MANIFEST.wire }
    ])
  })

  it('downloads when the cached build id is a different one', () => {
    const stale = { ...CACHED, buildId: 'c'.repeat(64) }
    const step = run(afterCacheRead(stale).session, { type: 'manifest-read', manifest: MANIFEST })
    expect(step.session.state).toEqual({
      kind: 'fetching',
      completedAssets: 0,
      totalAssets: 4,
      receivedBytes: 0,
      totalBytes: 4096
    })
    expect(step.effects).toEqual([{ kind: 'download' }])
  })

  it('downloads when there is no cache at all', () => {
    const step = run(afterCacheRead(null).session, { type: 'manifest-read', manifest: MANIFEST })
    expect(step.effects).toEqual([{ kind: 'download' }])
  })

  it('downloads nothing for a route the bundle does not list', () => {
    const step = run(afterCacheRead(null).session, {
      type: 'manifest-read',
      manifest: { ...MANIFEST, routes: [{ pathname: '/h/[hostId]/tasks', grants: [] }] }
    })
    expect(step.session.state).toEqual({ kind: 'native-route' })
    expect(step.effects).toEqual([])
  })

  it('downloads nothing for a route listed with a grant this shell does not implement', () => {
    const step = run(afterCacheRead(null).session, {
      type: 'manifest-read',
      manifest: {
        ...MANIFEST,
        routes: [{ pathname: '/h/[hostId]', grants: ['navigate', 'teleport'] }]
      }
    })
    expect(step.session.state).toEqual({ kind: 'native-route' })
    expect(step.effects).toEqual([])
  })

  it('leaves the route native for a desktop older than the field itself', () => {
    const step = run(afterCacheRead(null).session, {
      type: 'manifest-read',
      manifest: { ...MANIFEST, routes: undefined }
    })
    expect(step.session.state).toEqual({ kind: 'native-route' })
  })

  it('answers the route before it answers the wall, since a native route has none to show', () => {
    // A bundle this shell cannot open is not a reason to refuse a screen it was never going to
    // open: the wall belongs to the page, and this route is the native screen's.
    const step = run(afterCacheRead(null).session, {
      type: 'manifest-read',
      manifest: { ...MANIFEST, schemaVersion: 99, routes: [] }
    })
    expect(step.session.state).toEqual({ kind: 'native-route' })
  })

  it('still walls a listed route whose bundle this shell cannot read', () => {
    const step = run(afterCacheRead(null).session, {
      type: 'manifest-read',
      manifest: { ...MANIFEST, schemaVersion: 99 }
    })
    expect(step.session.state).toMatchObject({
      kind: 'wall',
      verdict: { reason: 'bundle-shell-too-old' }
    })
  })

  it('tells the page which routes it may keep, so it hands the rest back', () => {
    const step = run(afterCacheRead(null).session, { type: 'manifest-read', manifest: MANIFEST })
    expect(step.session.pageRoutes).toEqual(['/h/[hostId]'])
  })

  it('carries download progress and then stages and activates', () => {
    const fetching = run(afterCacheRead(null).session, {
      type: 'manifest-read',
      manifest: MANIFEST
    })
    const progressed = run(fetching.session, {
      type: 'fetch-progress',
      completedAssets: 2,
      totalAssets: 4,
      receivedBytes: 2048,
      totalBytes: 4096
    })
    expect(progressed.session.state).toMatchObject({ kind: 'fetching', completedAssets: 2 })
    const staged = run(progressed.session, { type: 'download-staged' })
    expect(staged.session.state).toEqual({ kind: 'activating', source: 'download' })
    const ready = run(staged.session, {
      type: 'activated',
      generationDirectory: '/cache/gen',
      sessionId: 'session-one',
      buildId: MANIFEST.buildId,
      totalBytes: 4096,
      elapsedMs: 900
    })
    expect(ready.session.state).toEqual({
      kind: 'ready',
      generationDirectory: '/cache/gen',
      sessionId: 'session-one',
      buildId: MANIFEST.buildId,
      totalBytes: 4096,
      elapsedMs: 900
    })
  })

  it('ignores progress that arrives after the fetching state is gone', () => {
    const ready = readySession()
    const step = run(ready.session, {
      type: 'fetch-progress',
      completedAssets: 1,
      totalAssets: 4,
      receivedBytes: 1,
      totalBytes: 4096
    })
    expect(step.session.state).toEqual(ready.session.state)
  })

  it('fails when the download or the cache write never produced a generation', () => {
    const step = run(afterCacheRead(null).session, {
      type: 'download-failed',
      cause: BUNDLE_REFUSED
    })
    expect(step.session.state).toEqual({
      kind: 'failed',
      reason: 'download-failed',
      retriedOnce: false
    })
  })
})

describe('a read the link cut short falls back to what is on disk', () => {
  /** Connected, a generation cached, the manifest read in flight — where the drop is felt. */
  function manifestInFlight() {
    return afterCacheRead(CACHED)
  }

  it('opens the cached generation when the socket drops before the reachability change does', () => {
    const step = run(manifestInFlight().session, { type: 'download-failed', cause: LINK_LOST })
    expect(step.session.state).toEqual({ kind: 'activating', source: 'cache' })
    expect(withoutRecord(step.effects)).toEqual([
      {
        kind: 'open-generation',
        directory: CACHED.directory,
        buildId: CACHED.buildId,
        totalBytes: CACHED.totalBytes
      }
    ])
    const ready = run(step.session, {
      type: 'activated',
      generationDirectory: CACHED.directory,
      sessionId: 'session-one',
      buildId: CACHED.buildId,
      totalBytes: CACHED.totalBytes,
      elapsedMs: 12
    })
    expect(ready.session.state).toMatchObject({ kind: 'ready', buildId: CACHED.buildId })
  })

  it('still says the workspace could not be downloaded when nothing is on disk', () => {
    const step = run(afterCacheRead(null).session, {
      type: 'download-failed',
      cause: LINK_LOST
    })
    expect(step.session.state).toEqual({
      kind: 'failed',
      reason: 'download-failed',
      retriedOnce: false
    })
    expect(withoutRecord(step.effects)).toEqual([])
  })

  it('leaves no notice on it, because nothing says an update was there to fail', () => {
    // The link went before the host said what it serves. "Update failed" would be a claim about a
    // generation this phone never heard of.
    const step = run(manifestInFlight().session, { type: 'download-failed', cause: LINK_LOST })
    expect(step.session.updateNotice).toBeNull()
  })
})

describe('a displayed generation is not restarted by the gates', () => {
  it.each(['connected', 'unreachable', 'connecting'] as const)(
    'keeps a ready session when reachability becomes %s',
    (reachability) => {
      const ready = readySession()
      const step = run(ready.session, { type: 'gates-changed', gates: gates({ reachability }) })
      expect(step.session.state).toEqual(ready.session.state)
      expect(step.effects).toEqual([])
    }
  )

  it('keeps a wall and a terminal failure', () => {
    const wall = started({ hostCapabilities: [] })
    expect(run(wall.session, { type: 'gates-changed', gates: gates() }).effects).toEqual([])
    const failed = run(afterCacheRead(null).session, {
      type: 'download-failed',
      cause: BUNDLE_REFUSED
    })
    expect(run(failed.session, { type: 'gates-changed', gates: gates() }).effects).toEqual([])
  })
})

describe('recovery follows the shell view contract', () => {
  it.each(['generation-unreadable', 'document-load-failed'] as const)(
    'deletes this host cache and runs once more on %s',
    (reason) => {
      const step = run(readySession().session, { type: 'shell-failed', reason })
      expect(step.effects).toEqual([{ kind: 'delete-cache' }, { kind: 'open-cache' }])
      expect(step.session.state).toEqual({ kind: 'checking' })
      expect(step.session.retriedOnce).toBe(true)
      expect(step.session.cached).toBeNull()
    }
  )

  it('takes a recovery through the gate rather than back to a manifest check', () => {
    const ready = readySession()
    // A reconnect whose status probe failed. Stored, not acted on: a workspace on screen is not
    // restarted by a gates change, which is how a ready session ends up holding one like this.
    const stale = run(ready.session, {
      type: 'gates-changed',
      gates: gates({ statusReadable: false, hostCapabilities: [] })
    })
    expect(stale.session.state).toMatchObject({ kind: 'ready' })
    const step = run(stale.session, { type: 'shell-failed', reason: 'document-load-failed' })
    // Not the wall the empty capability list would have produced, which nothing leaves.
    expect(step.session.state).toEqual({
      kind: 'failed',
      reason: 'status-unreadable',
      retriedOnce: true
    })
    expect(step.effects).toEqual([{ kind: 'delete-cache' }])
    const rearmed = run(step.session, { type: 'gates-changed', gates: gates() })
    expect(rearmed.session.state).toEqual({ kind: 'checking' })
    expect(rearmed.effects).toEqual([{ kind: 'open-cache' }])
  })

  it('hands a recovery back to the native screen when the host serves no bundle', () => {
    const stale = run(readySession().session, {
      type: 'gates-changed',
      gates: gates({ hostCapabilities: [] })
    })
    const step = run(stale.session, { type: 'shell-failed', reason: 'document-load-failed' })
    expect(step.session.state).toEqual({ kind: 'native-route' })
    // The cache still goes: the bytes that failed are suspect whatever screen follows them.
    expect(step.effects).toEqual([{ kind: 'delete-cache' }])
  })

  it('deletes the suspect cache and waits when the recovery lands mid-reconnect', () => {
    const dialling = run(readySession().session, {
      type: 'gates-changed',
      gates: gates({ reachability: 'connecting' })
    })
    const step = run(dialling.session, { type: 'shell-failed', reason: 'generation-unreadable' })
    expect(step.session.state).toEqual({ kind: 'checking' })
    expect(step.effects).toEqual([{ kind: 'delete-cache' }])
    expect(run(step.session, { type: 'gates-changed', gates: gates() }).effects).toEqual([
      { kind: 'open-cache' }
    ])
  })

  it.each(['generation-unreadable', 'document-load-failed'] as const)(
    'is terminal the second time %s is reported',
    (reason) => {
      const first = run(readySession().session, { type: 'shell-failed', reason })
      const refetched = readyAgain(first.session, 'session-two')
      const second = run(refetched.session, { type: 'shell-failed', reason })
      expect(second.effects).toEqual([])
      expect(second.session.state).toEqual({ kind: 'failed', reason, retriedOnce: true })
    }
  )

  it('remounts once on render-process-gone and never deletes anything', () => {
    const ready = readySession()
    const step = run(ready.session, { type: 'shell-failed', reason: 'render-process-gone' })
    expect(step.effects).toEqual([{ kind: 'remount' }])
    expect(step.session.state).toEqual(ready.session.state)
    const remounted = run(step.session, { type: 'remounted', sessionId: 'session-two' })
    expect(remounted.session.state).toMatchObject({
      kind: 'ready',
      sessionId: 'session-two',
      generationDirectory: CACHED.directory
    })
  })

  it('is terminal the second time the render process is gone, still without a delete', () => {
    const first = run(readySession().session, {
      type: 'shell-failed',
      reason: 'render-process-gone'
    })
    const remounted = run(first.session, { type: 'remounted', sessionId: 'session-two' })
    const second = run(remounted.session, { type: 'shell-failed', reason: 'render-process-gone' })
    expect(second.effects).toEqual([])
    expect(second.session.state).toEqual({
      kind: 'failed',
      reason: 'render-process-gone',
      retriedOnce: false
    })
  })

  it('is terminal on the first isolation-unavailable, with no retry and no delete', () => {
    const step = run(readySession().session, {
      type: 'shell-failed',
      reason: 'isolation-unavailable'
    })
    expect(step.effects).toEqual([])
    expect(step.session.state).toEqual({
      kind: 'failed',
      reason: 'isolation-unavailable',
      retriedOnce: false
    })
  })

  it('ignores a session id for a generation that is no longer ready', () => {
    const step = run(started().session, { type: 'remounted', sessionId: 'session-two' })
    expect(step.session.state).toEqual({ kind: 'checking' })
  })
})

describe('try again', () => {
  it('clears both latches and restarts the flow', () => {
    const first = run(readySession().session, {
      type: 'shell-failed',
      reason: 'document-load-failed'
    })
    const refetched = readyAgain(first.session, 'session-two')
    const failed = run(refetched.session, { type: 'shell-failed', reason: 'document-load-failed' })
    const retried = run(failed.session, { type: 'retry-pressed' })
    expect(retried.session.retriedOnce).toBe(false)
    expect(retried.session.remountedOnce).toBe(false)
    expect(retried.session.cached).toBeNull()
    expect(retried.effects).toEqual([{ kind: 'open-cache' }])
    // And the delete-and-refetch is available again.
    const again = run(
      run(retried.session, { type: 'cache-read', generation: CACHED }).session,
      { type: 'manifest-read', manifest: MANIFEST },
      {
        type: 'activated',
        generationDirectory: CACHED.directory,
        sessionId: 'session-three',
        buildId: MANIFEST.buildId,
        totalBytes: 4096,
        elapsedMs: 3
      },
      { type: 'shell-failed', reason: 'document-load-failed' }
    )
    expect(again.effects).toEqual([{ kind: 'delete-cache' }, { kind: 'open-cache' }])
  })

  it('stays native rather than looping when the host still serves no bundle', () => {
    const native = started({ hostCapabilities: [] })
    const retried = run(native.session, { type: 'retry-pressed' })
    expect(retried.session.state).toEqual({ kind: 'native-route' })
    expect(retried.effects).toEqual([])
  })

  it('does nothing but reset when no gates have arrived yet', () => {
    const step = run(createMobileWebShellSession(ROUTE), { type: 'retry-pressed' })
    expect(step.session.state).toEqual({ kind: 'checking' })
    expect(step.effects).toEqual([])
  })
})

describe('a result from a superseded flow reports into nothing', () => {
  it('drops the cache read of a run a reconnect replaced, so nothing opens unchecked', () => {
    const first = started({ reachability: 'unreachable' })
    const restarted = run(first.session, { type: 'gates-changed', gates: gates() })
    expect(restarted.effects).toEqual([{ kind: 'open-cache' }])
    // The offline read would have opened this generation with no compat check at all.
    const stale = run(restarted.session, {
      type: 'cache-read',
      flow: first.session.flow,
      generation: CACHED
    })
    expect(stale.effects).toEqual([])
    expect(stale.session.cached).toBeNull()
    expect(run(stale.session, { type: 'cache-read', generation: CACHED }).effects).toEqual([
      { kind: 'read-manifest' }
    ])
  })

  it('drops the manifest of a run the socket drop replaced, so no download is asked for', () => {
    const first = afterCacheRead(null)
    const restarted = run(first.session, {
      type: 'gates-changed',
      gates: gates({ reachability: 'unreachable' })
    })
    const stale = run(restarted.session, {
      type: 'manifest-read',
      flow: first.session.flow,
      manifest: MANIFEST
    })
    expect(stale.effects).toEqual([])
    expect(stale.session.state).toEqual({ kind: 'checking' })
    const current = run(stale.session, { type: 'cache-read', generation: null })
    expect(current.session.state).toEqual({ kind: 'offline' })
    expect(current.effects).toEqual([])
  })

  it('keeps a workspace on screen when the manifest read the drop abandoned finally rejects', () => {
    // The reproduced sequence: connected, cache read, manifest in flight, socket drops, the offline
    // path opens the cached generation, and only then does the abandoned RPC settle.
    const inFlight = afterCacheRead(CACHED)
    const offline = run(inFlight.session, {
      type: 'gates-changed',
      gates: gates({ reachability: 'unreachable' })
    })
    const ready = run(
      offline.session,
      { type: 'cache-read', generation: CACHED },
      {
        type: 'activated',
        generationDirectory: CACHED.directory,
        sessionId: 'session-one',
        buildId: CACHED.buildId,
        totalBytes: CACHED.totalBytes,
        elapsedMs: 4
      }
    )
    expect(ready.session.state).toMatchObject({ kind: 'ready' })
    const late = run(ready.session, {
      type: 'download-failed',
      cause: BUNDLE_REFUSED,
      flow: inFlight.session.flow
    })
    expect(late.session.state).toEqual(ready.session.state)
  })

  it('applies a remount of the current flow and ignores one from a replaced run', () => {
    const ready = readySession()
    const remounting = run(ready.session, { type: 'shell-failed', reason: 'render-process-gone' })
    const stale = run(remounting.session, {
      type: 'remounted',
      flow: remounting.session.flow - 1,
      sessionId: 'session-stale'
    })
    expect(stale.session.state).toEqual(ready.session.state)
    expect(
      run(stale.session, { type: 'remounted', sessionId: 'session-two' }).session.state
    ).toMatchObject({ sessionId: 'session-two' })
  })
})

describe('the remount budget is one per session, not one per reconnect', () => {
  it('keeps the latch set when the gates restart the flow after a load failure', () => {
    const remounted = run(
      readySession().session,
      { type: 'shell-failed', reason: 'render-process-gone' },
      { type: 'remounted', sessionId: 'session-two' },
      { type: 'shell-failed', reason: 'document-load-failed' }
    )
    expect(remounted.session.remountedOnce).toBe(true)
    const restarted = run(remounted.session, { type: 'gates-changed', gates: gates() })
    expect(restarted.session.remountedOnce).toBe(true)
    expect(run(restarted.session, { type: 'retry-pressed' }).session.remountedOnce).toBe(false)
  })
})

describe('only the state that mounted the view hears the view', () => {
  it('ignores the second failure of one native batch, leaving the first recovery running', () => {
    const recovering = run(readySession().session, {
      type: 'shell-failed',
      reason: 'document-load-failed'
    })
    const batched = run(recovering.session, {
      type: 'shell-failed',
      reason: 'render-process-gone'
    })
    expect(batched.session.state).toEqual({ kind: 'checking' })
    expect(batched.effects).toEqual([])
    expect(batched.session.flow).toBe(recovering.session.flow)
    // And the cache read the recovery already asked for still lands on the recovery.
    expect(run(batched.session, { type: 'cache-read', generation: null }).effects).toEqual([
      { kind: 'read-manifest' }
    ])
  })

  it('leaves a wall standing when a view that is no longer mounted reports a failure', () => {
    const wall = started({ hostCapabilities: [] })
    const step = run(wall.session, { type: 'shell-failed', reason: 'isolation-unavailable' })
    expect(step.session.state).toEqual(wall.session.state)
    expect(step.effects).toEqual([])
  })
})

describe('a gates change that says nothing new starts nothing', () => {
  it('leaves a check in flight alone rather than sweeping and reading a second time', () => {
    const checking = started()
    const again = run(checking.session, { type: 'gates-changed', gates: gates() })
    expect(again.effects).toEqual([])
    expect(again.session.flow).toBe(checking.session.flow)
  })

  it('holds the offline screen through a reconnect cycle that never reaches the host', () => {
    const offline = run(started({ reachability: 'unreachable' }).session, {
      type: 'cache-read',
      generation: null
    })
    const cycled = run(
      offline.session,
      { type: 'gates-changed', gates: gates({ reachability: 'unreachable' }) },
      { type: 'gates-changed', gates: gates({ reachability: 'unreachable' }) }
    )
    expect(cycled.effects).toEqual([])
    expect(cycled.session.state).toEqual({ kind: 'offline' })
  })

  it('restarts on the verdict that changed, not on the object that was rebuilt', () => {
    const checking = started({ statusPending: true })
    const settled = run(checking.session, { type: 'gates-changed', gates: gates() })
    expect(settled.effects).toEqual([{ kind: 'open-cache' }])
  })

  it('drops a check in flight to the native screen when the host stops serving a bundle', () => {
    const checking = started()
    const step = run(checking.session, {
      type: 'gates-changed',
      gates: gates({ hostCapabilities: [] })
    })
    expect(step.session.state).toEqual({ kind: 'native-route' })
  })
})

/**
 * A document that commits and then says nothing.
 *
 * The WebView reports a finished load for a response it painted, which a bundle whose entry threw
 * during evaluation still produces. Only the page's own first frame proves its code ran, so the
 * wait between the two is where a blank screen would otherwise live forever.
 */
describe('the page has to speak for the document that loaded', () => {
  it('arms one wait when the document finishes and the page has not spoken', () => {
    const step = run(readySession().session, { type: 'document-loaded' })
    expect(step.effects).toEqual([{ kind: 'await-page-ready' }])
    expect(step.session.state.kind).toBe('ready')
  })

  it('arms nothing when the page spoke first, because there is nothing left to wait for', () => {
    const step = run(
      readySession().session,
      { type: 'page-ready', reports: [], accepts: [] },
      { type: 'document-loaded' }
    )
    expect(step.effects).toEqual([])
    expect(step.session.pageReady).toBe(true)
  })

  it('arms nothing outside ready, where no view exists to have loaded anything', () => {
    const step = run(afterCacheRead(null).session, { type: 'document-loaded' })
    expect(step.effects).toEqual([])
  })

  it('deletes the cache and runs the flow again when the wait expires', () => {
    const ready = run(readySession().session, { type: 'document-loaded' })
    const step = run(ready.session, { type: 'page-ready-deadline' })
    // The same recovery `document-load-failed` gets from the view: the bytes on disk are suspect,
    // so they go and the host is asked once more.
    expect(step.effects).toEqual([{ kind: 'delete-cache' }, { kind: 'open-cache' }])
    expect(step.session.retriedOnce).toBe(true)
    expect(step.session.state.kind).toBe('checking')
  })

  it('does nothing when the wait expires after the page has spoken', () => {
    const step = run(
      readySession().session,
      { type: 'document-loaded' },
      { type: 'page-ready', reports: [], accepts: [] },
      { type: 'page-ready-deadline' }
    )
    expect(step.effects).toEqual([])
    expect(step.session.state.kind).toBe('ready')
  })

  it('drops the expiry of a wait a restarted flow left behind', () => {
    const ready = run(readySession().session, { type: 'document-loaded' })
    const step = run(
      ready.session,
      { type: 'retry-pressed' },
      { type: 'page-ready-deadline', flow: ready.session.flow }
    )
    expect(step.session.state.kind).toBe('checking')
    expect(step.session.retriedOnce).toBe(false)
  })

  it('makes the second document prove itself, rather than riding the first one word', () => {
    const spoken = run(readySession().session, { type: 'page-ready', reports: [], accepts: [] })
    const remounted = run(spoken.session, { type: 'remounted', sessionId: 'session-two' })
    expect(remounted.session.pageReady).toBe(false)
    expect(run(remounted.session, { type: 'document-loaded' }).effects).toEqual([
      { kind: 'await-page-ready' }
    ])
  })

  it('leaves a remounted document its own wait when the first one expires late', () => {
    const first = run(
      readySession().session,
      { type: 'document-loaded' },
      { type: 'page-ready', reports: [], accepts: [] }
    )
    const armed = first.session.flow
    const second = run(
      first.session,
      { type: 'shell-failed', reason: 'render-process-gone' },
      { type: 'remounted', sessionId: 'session-two' },
      { type: 'document-loaded' }
    )
    // The second document is inside its own wait and has not spoken yet, so the only thing that can
    // keep the first document's expiry off it is the flow the remount started.
    const step = run(second.session, { type: 'page-ready-deadline', flow: armed })
    expect(step.effects).toEqual([])
    expect(step.session.state).toMatchObject({ kind: 'ready', sessionId: 'session-two' })
  })

  it('makes a freshly activated generation prove itself too', () => {
    const spoken = run(readySession().session, { type: 'page-ready', reports: [], accepts: [] })
    const reactivated = run(spoken.session, {
      type: 'activated',
      generationDirectory: CACHED.directory,
      sessionId: 'session-three',
      buildId: MANIFEST.buildId,
      totalBytes: MANIFEST.totalBytes,
      elapsedMs: 9
    })
    expect(reactivated.session.pageReady).toBe(false)
  })
})

/**
 * A commit is not a paint, and `ready` is posted before the page has built anything: the only
 * thing that says the view is worth showing is the page saying so.
 */
describe('the page reporting a frame on screen', () => {
  it('records what the ready declared and keeps the frame covered until the report', () => {
    const spoken = run(readySession().session, {
      type: 'page-ready',
      reports: [BRIDGE_PAGE_PAINTED],
      accepts: []
    })
    expect(spoken.session.pageReportsPaint).toBe(true)
    expect(spoken.session.pagePainted).toBe(false)
    expect(shellPageFrame(spoken.session)).toBe('unpainted')
    const painted = run(spoken.session, { type: 'page-painted' })
    expect(painted.session.pagePainted).toBe(true)
    expect(shellPageFrame(painted.session)).toBe('painted')
  })

  it('new shell, old page: ignores an undeclared report and uncovers on ready', () => {
    const spoken = run(readySession().session, { type: 'page-ready', reports: [], accepts: [] })
    const step = run(spoken.session, { type: 'page-painted' })
    expect(step.session.pagePainted).toBe(false)
    // Uncovered anyway: `ready` is the newest word a page built before the report can say.
    expect(shellPageFrame(step.session)).toBe('painted')
  })

  it('re-reads the declaration on every ask, because a reload asks again', () => {
    const declared = run(readySession().session, {
      type: 'page-ready',
      reports: [BRIDGE_PAGE_PAINTED],
      accepts: []
    })
    const reloaded = run(declared.session, { type: 'page-ready', reports: [], accepts: [] })
    expect(reloaded.session.pageReportsPaint).toBe(false)
  })

  it('makes a remounted document report its own frame', () => {
    const painted = run(
      readySession().session,
      { type: 'page-ready', reports: [BRIDGE_PAGE_PAINTED], accepts: [] },
      { type: 'page-painted' }
    )
    const remounted = run(painted.session, { type: 'remounted', sessionId: 'session-two' })
    expect(remounted.session.pagePainted).toBe(false)
    expect(remounted.session.pageReportsPaint).toBe(false)
    expect(shellPageFrame(remounted.session)).toBe('unpainted')
  })

  it('makes a freshly activated generation report its own frame', () => {
    const painted = run(
      readySession().session,
      { type: 'page-ready', reports: [BRIDGE_PAGE_PAINTED], accepts: [] },
      { type: 'page-painted' }
    )
    const reactivated = run(painted.session, {
      type: 'activated',
      generationDirectory: CACHED.directory,
      sessionId: 'session-three',
      buildId: MANIFEST.buildId,
      totalBytes: MANIFEST.totalBytes,
      elapsedMs: 9
    })
    expect(reactivated.session.pagePainted).toBe(false)
    expect(reactivated.session.pageReportsPaint).toBe(false)
  })

  it('makes the document that replaced a painted one inside this mount report its own frame', () => {
    const painted = run(
      readySession().session,
      { type: 'page-ready', reports: [BRIDGE_PAGE_PAINTED], accepts: [] },
      { type: 'page-painted' }
    )
    expect(shellPageFrame(painted.session)).toBe('painted')
    // No new session and no new generation: the view reloaded under the one already on screen.
    const restarted = run(painted.session, { type: 'document-started' })
    expect(restarted.session.pagePainted).toBe(false)
    const reasked = run(restarted.session, {
      type: 'page-ready',
      reports: [BRIDGE_PAGE_PAINTED],
      accepts: []
    })
    expect(shellPageFrame(reasked.session)).toBe('unpainted')
    expect(shellPageFrame(run(reasked.session, { type: 'page-painted' }).session)).toBe('painted')
  })

  it('retires the wait the document it replaced armed', () => {
    const loaded = run(readySession().session, { type: 'document-loaded' })
    expect(loaded.effects).toEqual([{ kind: 'await-page-ready' }])
    const armed = loaded.session.flow
    const spoken = run(loaded.session, {
      type: 'page-ready',
      reports: [BRIDGE_PAGE_PAINTED],
      accepts: []
    })
    const restarted = run(spoken.session, { type: 'document-started' })
    // The replacement is still loading and has said nothing, which is exactly what the retired
    // document's deadline reads as a document that never loaded.
    const expired = run(restarted.session, { type: 'page-ready-deadline', flow: armed })
    expect(expired.session.state.kind).toBe('ready')
    // And the replacement arms a wait of its own, so a document that really never speaks still
    // takes the session down.
    const reloaded = run(restarted.session, { type: 'document-loaded' })
    expect(reloaded.effects).toEqual([{ kind: 'await-page-ready' }])
  })

  it('keeps the frame of a document that repeats its own handshake', () => {
    const painted = run(
      readySession().session,
      { type: 'page-ready', reports: [BRIDGE_PAGE_PAINTED], accepts: [] },
      { type: 'page-painted' },
      { type: 'page-ready', reports: [BRIDGE_PAGE_PAINTED], accepts: [] }
    )
    // The document never restarted, so its frame is still the one on screen.
    expect(painted.session.pagePainted).toBe(true)
    expect(shellPageFrame(painted.session)).toBe('painted')
  })

  it('records nothing from a page whose generation is no longer on screen', () => {
    const failed = run(readySession().session, {
      type: 'shell-failed',
      reason: 'render-process-gone'
    })
    expect(run(failed.session, { type: 'page-painted' }).session.pagePainted).toBe(false)
  })
})
