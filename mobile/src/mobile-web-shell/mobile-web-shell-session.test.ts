import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_BUNDLE_CAPABILITY } from '../../../src/shared/mobile-web-bundle/mobile-web-bundle-capability'
import {
  createMobileWebShellSession,
  reduceMobileWebShellSession,
  type CachedGeneration,
  type MobileWebShellGates,
  type MobileWebShellManifestFacts,
  type MobileWebShellSession,
  type MobileWebShellSessionEvent,
  type MobileWebShellStep
} from './mobile-web-shell-session'

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

function run(
  session: MobileWebShellSession,
  ...events: readonly MobileWebShellSessionEvent[]
): MobileWebShellStep {
  let step: MobileWebShellStep = { session, effects: [] }
  for (const event of events) {
    step = reduceMobileWebShellSession(step.session, event)
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

  it('never walls a host whose status could not be read', () => {
    const step = started({ statusReadable: false, hostCapabilities: [] })
    expect(step.session.state).toEqual({ kind: 'checking' })
    expect(step.effects).toEqual([])
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
    const step = run(afterCacheRead(null).session, { type: 'download-failed' })
    expect(step.session.state).toEqual({
      kind: 'failed',
      reason: 'download-failed',
      retriedOnce: false
    })
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
    const failed = run(afterCacheRead(null).session, { type: 'download-failed' })
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

  it.each(['generation-unreadable', 'document-load-failed'] as const)(
    'is terminal the second time %s is reported',
    (reason) => {
      const first = run(readySession().session, { type: 'shell-failed', reason })
      const second = run(first.session, { type: 'shell-failed', reason })
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
    const failed = run(first.session, { type: 'shell-failed', reason: 'document-load-failed' })
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
