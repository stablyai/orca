import { describe, expect, it } from 'vitest'
import {
  createMobileWebShellSession,
  readyAgain,
  CACHED,
  MANIFEST,
  awaitingManifest,
  gates,
  readySession,
  run,
  started,
  BUNDLE_REFUSED,
  LINK_LOST,
  withoutRecord
} from './mobile-web-shell-session-test-fixtures'
import type { CachedGeneration } from './mobile-web-shell-session-contract'
import { shellPageFrame } from './shell-page-frame'

function afterCacheRead(generation: CachedGeneration | null) {
  return run(started().session, { type: 'cache-read', generation })
}

describe('the connected flow', () => {
  it('asks the host for a manifest once the cache has been read', () => {
    expect(afterCacheRead(null).effects).toEqual([{ kind: 'read-manifest' }])
    const cached = afterCacheRead(CACHED)
    expect(cached.session.state).toEqual({ kind: 'activating', source: 'cache' })
    expect(cached.effects).toEqual([
      {
        kind: 'open-generation',
        directory: CACHED.directory,
        buildId: CACHED.buildId,
        totalBytes: CACHED.totalBytes
      },
      { kind: 'read-manifest' }
    ])
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

  it('opens a same-build hit without paging, under the fresh grants', () => {
    // Use unservable cached routes to prove fresh manifest grants decide the online same-build session.
    const stale = { ...CACHED, routes: [{ pathname: '/h/[hostId]', grants: ['teleport'] }] }
    const step = run(afterCacheRead(stale).session, { type: 'manifest-read', manifest: MANIFEST })
    expect(step.session.state).toEqual({ kind: 'activating', source: 'cache' })
    // Opening must not rewrite the manifest while the native view reads it.
    expect(step.effects).toEqual([
      {
        kind: 'open-generation',
        directory: CACHED.directory,
        buildId: CACHED.buildId,
        totalBytes: CACHED.totalBytes
      }
    ])
    expect(step.session.routeGrants).toEqual(['navigate', 'native.storage.read'])
  })

  it('keeps a same-build cache open instead of opening it again', () => {
    const step = run(afterCacheRead(CACHED).session, { type: 'manifest-read', manifest: MANIFEST })
    expect(step.session.state).toEqual({ kind: 'activating', source: 'cache' })
    expect(step.effects).toEqual([])
  })

  it('downloads beside a cached generation instead of covering it', () => {
    const stale = { ...CACHED, buildId: 'c'.repeat(64) }
    const step = run(afterCacheRead(stale).session, { type: 'manifest-read', manifest: MANIFEST })
    expect(step.session.state).toEqual({ kind: 'activating', source: 'cache' })
    expect(step.effects).toEqual([{ kind: 'download' }])
    expect(step.session.requestedBuildId).toBe(MANIFEST.buildId)
  })

  it('downloads when there is no cache at all', () => {
    const step = run(afterCacheRead(null).session, { type: 'manifest-read', manifest: MANIFEST })
    expect(step.effects).toEqual([{ kind: 'download' }])
  })

  it('walls a listed route whose page is older than this shell, as a desktop to update', () => {
    for (const manifest of [
      { ...MANIFEST, pageVersion: 0 },
      { ...MANIFEST, pageVersion: undefined }
    ]) {
      const step = run(afterCacheRead(null).session, { type: 'manifest-read', manifest })
      expect(step.session.state).toEqual({
        kind: 'wall',
        verdict: {
          kind: 'blocked',
          reason: 'bundle-incompatible',
          side: 'desktop',
          pageVersion: 0,
          requiredPageVersion: 1
        }
      })
    }
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
  function manifestInFlight() {
    return afterCacheRead(CACHED)
  }

  it('keeps the cached open when the socket drops before the manifest does', () => {
    const step = run(manifestInFlight().session, { type: 'download-failed', cause: LINK_LOST })
    expect(step.session.state).toEqual({ kind: 'activating', source: 'cache' })
    expect(withoutRecord(step.effects)).toEqual([])
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

  it('does not delete the host cache when Account usage fails to open', () => {
    const routes = [...CACHED.routes, { pathname: '/h/[hostId]/accounts', grants: ['navigate'] }]
    const cached = { ...CACHED, routes }
    const manifest = { ...MANIFEST, routes }
    const ready = run(
      createMobileWebShellSession('/h/host-1/accounts'),
      { type: 'gates-changed', gates: gates() },
      { type: 'cache-read', generation: cached },
      { type: 'manifest-read', manifest },
      {
        type: 'activated',
        generationDirectory: cached.directory,
        sessionId: 'session-accounts',
        buildId: manifest.buildId,
        totalBytes: manifest.totalBytes,
        elapsedMs: 12
      }
    )
    expect(ready.session.state.kind).toBe('ready')
    const step = run(ready.session, { type: 'shell-failed', reason: 'document-load-failed' })
    expect(step.effects).toEqual([{ kind: 'open-cache' }])
  })

  it('is terminal the second time an unreadable generation needs a refetch', () => {
    const unreadable = { type: 'shell-failed', reason: 'generation-unreadable' } as const
    const first = run(readySession().session, unreadable)
    const refetched = readyAgain(first.session, 'session-two')
    const second = run(refetched.session, unreadable)
    expect(second.effects).toEqual([])
    expect(second.session.state).toEqual({
      kind: 'failed',
      reason: 'generation-unreadable',
      retriedOnce: true
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

  it('remounts again when the render process goes after the remounted page painted', () => {
    const recovered = run(
      readySession().session,
      { type: 'shell-failed', reason: 'render-process-gone' },
      { type: 'remounted', sessionId: 'session-two' },
      { type: 'page-ready' },
      { type: 'page-painted' }
    )
    const second = run(recovered.session, { type: 'shell-failed', reason: 'render-process-gone' })
    expect(second.effects).toEqual([{ kind: 'remount' }])
    expect(second.session.state).toMatchObject({ kind: 'ready', sessionId: 'session-two' })
  })
})

describe('try again', () => {
  it('clears every latch, deletes the unreadable files and restarts the flow', () => {
    const unreadable = { type: 'shell-failed', reason: 'generation-unreadable' } as const
    const lost = run(readySession().session, {
      type: 'shell-failed',
      reason: 'render-process-gone'
    })
    const remounted = run(lost.session, { type: 'remounted', sessionId: 'session-remounted' })
    const first = run(remounted.session, unreadable)
    const refetched = readyAgain(first.session, 'session-two')
    const failed = run(refetched.session, unreadable)
    expect(failed.session.retriedOnce).toBe(true)
    expect(failed.session.remountedOnce).toBe(true)
    const retried = run(failed.session, { type: 'retry-pressed' })
    expect(retried.session.retriedOnce).toBe(false)
    expect(retried.session.remountedOnce).toBe(false)
    expect(retried.session.cached).toBeNull()
    expect(retried.effects).toEqual([{ kind: 'delete-cache' }, { kind: 'open-cache' }])
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
      unreadable
    )
    expect(again.effects).toEqual([{ kind: 'delete-cache' }, { kind: 'open-cache' }])
  })
})

describe('a result from a superseded flow reports into nothing', () => {
  it('drops the cache read of a run a reconnect replaced, so nothing opens unchecked', () => {
    const first = started({ reachability: 'unreachable' })
    const restarted = run(first.session, { type: 'gates-changed', gates: gates() })
    expect(restarted.effects).toEqual([{ kind: 'open-cache' }])
    const stale = run(restarted.session, {
      type: 'cache-read',
      flow: first.session.flow,
      generation: CACHED
    })
    expect(stale.effects).toEqual([])
    expect(stale.session.cached).toBeNull()
    expect(run(stale.session, { type: 'cache-read', generation: CACHED }).effects).toEqual([
      {
        kind: 'open-generation',
        directory: CACHED.directory,
        buildId: CACHED.buildId,
        totalBytes: CACHED.totalBytes
      },
      { kind: 'read-manifest' }
    ])
  })

  it('keeps a workspace on screen when the manifest read the drop abandoned finally rejects', () => {
    // Settle the abandoned RPC only after socket loss opens cache, exposing any missing flow guard.
    const inFlight = awaitingManifest(CACHED)
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
})

describe('a reconnect does not refill the remount budget', () => {
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
      reason: 'generation-unreadable'
    })
    const batched = run(recovering.session, {
      type: 'shell-failed',
      reason: 'render-process-gone'
    })
    expect(batched.session.state).toEqual({ kind: 'checking' })
    expect(batched.effects).toEqual([])
    expect(batched.session.flow).toBe(recovering.session.flow)
    expect(run(batched.session, { type: 'cache-read', generation: null }).effects).toEqual([
      { kind: 'read-manifest' }
    ])
  })
})

// A finished WebView load can still have failed script evaluation; only page ready proves its code ran.
describe('the page has to speak for the document that loaded', () => {
  it('does nothing when the wait expires after the page has spoken', () => {
    const step = run(
      readySession().session,
      { type: 'document-loaded' },
      { type: 'page-ready' },
      { type: 'page-ready-deadline' }
    )
    expect(step.effects).toEqual([])
    expect(step.session.state.kind).toBe('ready')
  })

  it('leaves a remounted document its own wait when the first one expires late', () => {
    const first = run(readySession().session, { type: 'document-loaded' }, { type: 'page-ready' })
    const armed = first.session.flow
    const second = run(
      first.session,
      { type: 'shell-failed', reason: 'render-process-gone' },
      { type: 'remounted', sessionId: 'session-two' },
      { type: 'document-loaded' }
    )
    // Only the new flow can protect an unready replacement from the retired document’s expiry.
    const step = run(second.session, { type: 'page-ready-deadline', flow: armed })
    expect(step.effects).toEqual([])
    expect(step.session.state).toMatchObject({ kind: 'ready', sessionId: 'session-two' })
  })
})

// Refused/uncommitted loads may report nothing; retain a deadline for iOS cancellation (#28626).
describe('the view has to finish the document it was given', () => {
  it('remounts the same files when no document ever finished', () => {
    const started = run(readySession().session, { type: 'document-started' })
    const step = run(started.session, { type: 'document-load-deadline' })
    expect(step.effects).toEqual([{ kind: 'remount' }])
  })
})

// Neither WebView commit nor page ready proves paint; keep the cover until the page reports a frame.
describe('the page reporting a frame on screen', () => {
  it('makes the document that replaced a painted one inside this mount report its own frame', () => {
    const painted = run(readySession().session, { type: 'page-ready' }, { type: 'page-painted' })
    expect(shellPageFrame(painted.session)).toBe('painted')
    const restarted = run(painted.session, { type: 'document-started' })
    expect(restarted.session.pagePainted).toBe(false)
    const reasked = run(restarted.session, { type: 'page-ready' })
    expect(shellPageFrame(reasked.session)).toBe('unpainted')
    expect(shellPageFrame(run(reasked.session, { type: 'page-painted' }).session)).toBe('painted')
  })
})

describe('a cached page opened before the verdict', () => {
  const NEWER = { ...MANIFEST, buildId: 'c'.repeat(64) }

  function openedWhileDialling() {
    const dialling = started({ reachability: 'connecting' })
    return run(
      dialling.session,
      { type: 'cache-read', generation: CACHED },
      {
        type: 'activated',
        generationDirectory: CACHED.directory,
        sessionId: 'session-early',
        buildId: CACHED.buildId,
        totalBytes: CACHED.totalBytes,
        elapsedMs: 1
      }
    )
  }

  it('checks for a newer build once the verdict opens, and stages it behind the page', () => {
    const opened = run(openedWhileDialling().session, { type: 'gates-changed', gates: gates() })
    expect(opened.session.state).toMatchObject({ kind: 'ready', sessionId: 'session-early' })
    expect(opened.effects).toEqual([{ kind: 'read-manifest' }])
    const staged = run(opened.session, { type: 'manifest-read', manifest: NEWER })
    expect(staged.session.state).toMatchObject({ kind: 'ready', sessionId: 'session-early' })
    expect(staged.effects).toEqual([{ kind: 'stage-update' }])
  })

  it('stages the newer build when the manifest answers after the page document starts', () => {
    const opened = run(openedWhileDialling().session, { type: 'gates-changed', gates: gates() })
    const asked = opened.session.flow
    const started = run(opened.session, { type: 'document-started' })
    const staged = run(started.session, { type: 'manifest-read', manifest: NEWER, flow: asked })
    expect(staged.effects).toEqual([{ kind: 'stage-update' }])
  })

  it('walls a page that already talked when a new connection puts it outside the window', () => {
    const talked = run(openedWhileDialling().session, { type: 'gates-changed', gates: gates() })
    const reconnected = run(
      talked.session,
      { type: 'gates-changed', gates: gates({ reachability: 'connecting' }) },
      {
        type: 'gates-changed',
        gates: gates({ hostStatus: { protocolVersion: 10, minCompatibleMobileVersion: 99 } })
      }
    )
    expect(reconnected.session.state).toEqual({
      kind: 'wall',
      verdict: {
        kind: 'blocked',
        reason: 'bundle-incompatible',
        side: 'mobile',
        bundleRuntimeProtocolVersion: CACHED.compat.runtimeProtocolVersion,
        requiredBundleRuntimeProtocolVersion: 99
      }
    })
  })
})
