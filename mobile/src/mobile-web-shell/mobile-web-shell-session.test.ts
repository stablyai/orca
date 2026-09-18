import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
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

function gates(overrides: Partial<MobileWebShellGates> = {}): MobileWebShellGates {
  return {
    statusPending: false,
    statusReadable: true,
    reachability: 'connected',
    hostCapabilities: [MOBILE_WEB_BUNDLE_CAPABILITY],
    hostStatus: { protocolVersion: 10, minCompatibleMobileVersion: 1 },
    ...overrides
  }
}

const MANIFEST: MobileWebShellManifestFacts = {
  buildId: 'b'.repeat(64),
  schemaVersion: 1,
  runtimeProtocolVersion: 5,
  minCompatibleRuntimeProtocolVersion: 2,
  totalBytes: 4096,
  totalAssets: 4
}

const CACHED: CachedGeneration = {
  buildId: MANIFEST.buildId,
  directory: '/cache/mobile-web/host/generations/b',
  totalBytes: 4096
}

/** An event as a test writes it. An effect result is stamped with the flow the session is on, which
 *  is what an in-order runner does; a test replaying a superseded run pins the flow itself. */
type PendingEvent<E = MobileWebShellSessionEvent> = E extends { flow: number }
  ? Omit<E, 'flow'> & { readonly flow?: number }
  : E

function stamp(flow: number, event: PendingEvent): MobileWebShellSessionEvent {
  switch (event.type) {
    case 'gates-changed':
    case 'shell-failed':
    case 'retry-pressed':
      return event
    case 'cache-read':
    case 'manifest-read':
    case 'fetch-progress':
    case 'download-staged':
    case 'activated':
    case 'remounted':
    case 'download-failed':
      return { ...event, flow: event.flow ?? flow }
  }
}

function run(
  session: MobileWebShellSession,
  ...events: readonly PendingEvent[]
): MobileWebShellStep {
  let step: MobileWebShellStep = { session, effects: [] }
  for (const event of events) {
    step = reduceMobileWebShellSession(step.session, stamp(step.session.flow, event))
  }
  return step
}

function started(overrides: Partial<MobileWebShellGates> = {}): MobileWebShellStep {
  return run(createMobileWebShellSession(), { type: 'gates-changed', gates: gates(overrides) })
}

/** Connected, capability present, cache read, manifest in flight. */
function afterCacheRead(generation: CachedGeneration | null): MobileWebShellStep {
  return run(started().session, { type: 'cache-read', generation })
}

function readySession(): MobileWebShellStep {
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
function readyAgain(session: MobileWebShellSession, sessionId: string): MobileWebShellStep {
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

  it('walls a readable host that serves no bundle', () => {
    const step = started({ hostCapabilities: [] })
    expect(step.session.state).toEqual({
      kind: 'wall',
      verdict: { kind: 'blocked', reason: 'bundle-unavailable' }
    })
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
  it('opens a cached generation with no compat check when the host is unreachable', () => {
    const start = started({ reachability: 'unreachable', hostCapabilities: [] })
    const step = run(start.session, { type: 'cache-read', generation: CACHED })
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
    expect(staged.session.state).toEqual({ kind: 'activating' })
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
      failure: 'bundle'
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
    const step = run(manifestInFlight().session, { type: 'download-failed', failure: 'transport' })
    expect(step.session.state).toEqual({ kind: 'activating' })
    expect(step.effects).toEqual([
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
      failure: 'transport'
    })
    expect(step.session.state).toEqual({
      kind: 'failed',
      reason: 'download-failed',
      retriedOnce: false
    })
    expect(step.effects).toEqual([])
  })

  it('fails on a verdict about the bundle even with a generation cached', () => {
    // A host that refuses the read, or bytes that do not hash, is an answer about the bundle. A
    // cached generation is no reason to hide it behind a workspace that is merely older.
    const step = run(manifestInFlight().session, { type: 'download-failed', failure: 'bundle' })
    expect(step.session.state).toEqual({
      kind: 'failed',
      reason: 'download-failed',
      retriedOnce: false
    })
    expect(step.effects).toEqual([])
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
      failure: 'bundle'
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

  it('still walls a recovery whose host readably serves no bundle', () => {
    const stale = run(readySession().session, {
      type: 'gates-changed',
      gates: gates({ hostCapabilities: [] })
    })
    const step = run(stale.session, { type: 'shell-failed', reason: 'document-load-failed' })
    expect(step.session.state).toEqual({
      kind: 'wall',
      verdict: { kind: 'blocked', reason: 'bundle-unavailable' }
    })
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

  it('walls again rather than looping when the host still serves no bundle', () => {
    const wall = started({ hostCapabilities: [] })
    const retried = run(wall.session, { type: 'retry-pressed' })
    expect(retried.session.state).toMatchObject({ kind: 'wall' })
    expect(retried.effects).toEqual([])
  })

  it('does nothing but reset when no gates have arrived yet', () => {
    const step = run(createMobileWebShellSession(), { type: 'retry-pressed' })
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
      failure: 'bundle',
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

  it('walls a check in flight the moment the host stops serving a bundle', () => {
    const checking = started()
    const step = run(checking.session, {
      type: 'gates-changed',
      gates: gates({ hostCapabilities: [] })
    })
    expect(step.session.state).toEqual({
      kind: 'wall',
      verdict: { kind: 'blocked', reason: 'bundle-unavailable' }
    })
  })
})
