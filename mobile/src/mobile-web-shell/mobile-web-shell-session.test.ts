import { describe, expect, it } from 'vitest'
import {
  readyAgain,
  CACHED,
  MANIFEST,
  afterCacheRead,
  gates,
  readySession,
  run,
  started,
  BUNDLE_REFUSED,
  LINK_LOST,
  withoutRecord
} from './mobile-web-shell-session-test-fixtures'
import { shellPageFrame } from './shell-page-frame'

const NO_BUNDLE_WALL = { kind: 'wall', verdict: { kind: 'blocked', reason: 'bundle-unavailable' } }

describe('the gates decide whether a step is taken at all', () => {
  it('picks the flow back up if that status ever becomes readable', () => {
    const unreadable = started({ statusReadable: false, hostCapabilities: [] })
    const step = run(unreadable.session, { type: 'gates-changed', gates: gates() })
    expect(step.session.state).toEqual({ kind: 'checking' })
    expect(step.effects).toEqual([{ kind: 'open-cache' }])
  })
})

describe('the offline rule', () => {
  it('waits on a cache read that lands mid-dial instead of opening it unchecked', () => {
    const dialling = run(started().session, {
      type: 'gates-changed',
      gates: gates({ reachability: 'connecting' })
    })
    const step = run(dialling.session, { type: 'cache-read', generation: CACHED })
    // Wait through connecting so the host’s imminent compatibility verdict is not skipped.
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
    expect(step.session.routeGrants).toEqual(['navigate'])
  })
})

describe('a read the link cut short falls back to what is on disk', () => {
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
  it('takes a recovery through the gate rather than back to a manifest check', () => {
    const ready = readySession()
    // Store unreadable reconnect gates under ready without restarting the running workspace.
    const stale = run(ready.session, {
      type: 'gates-changed',
      gates: gates({ statusReadable: false, hostCapabilities: [] })
    })
    expect(stale.session.state).toMatchObject({ kind: 'ready' })
    const step = run(stale.session, { type: 'shell-failed', reason: 'document-load-failed' })
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

  it('walls a recovery when the host no longer serves a bundle', () => {
    const stale = run(readySession().session, {
      type: 'gates-changed',
      gates: gates({ hostCapabilities: [] })
    })
    const step = run(stale.session, { type: 'shell-failed', reason: 'document-load-failed' })
    expect(step.session.state).toEqual(NO_BUNDLE_WALL)
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
})

describe('try again', () => {
  it('clears both latches and restarts the flow', () => {
    const lost = run(readySession().session, {
      type: 'shell-failed',
      reason: 'render-process-gone'
    })
    const remounted = run(lost.session, { type: 'remounted', sessionId: 'session-remounted' })
    const first = run(remounted.session, {
      type: 'shell-failed',
      reason: 'document-load-failed'
    })
    const refetched = readyAgain(first.session, 'session-two')
    const failed = run(refetched.session, { type: 'shell-failed', reason: 'document-load-failed' })
    expect(failed.session.retriedOnce).toBe(true)
    expect(failed.session.remountedOnce).toBe(true)
    const retried = run(failed.session, { type: 'retry-pressed' })
    expect(retried.session.retriedOnce).toBe(false)
    expect(retried.session.remountedOnce).toBe(false)
    expect(retried.session.cached).toBeNull()
    expect(retried.effects).toEqual([{ kind: 'open-cache' }])
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
    // Settle the abandoned RPC only after socket loss opens cache, exposing any missing flow guard.
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

  it('keeps a first open checking while the dial retries, then says offline when it stops', () => {
    const retrying = gates({ reachability: 'unreachable', retrying: true })
    const waiting = run(started(retrying).session, { type: 'cache-read', generation: null })
    expect(waiting.session.state).toEqual({ kind: 'checking' })

    const gaveUp = run(waiting.session, {
      type: 'gates-changed',
      gates: gates({ reachability: 'unreachable' })
    })
    expect(gaveUp.effects).toEqual([{ kind: 'open-cache' }])
    const offline = run(gaveUp.session, { type: 'cache-read', generation: null })
    expect(offline.session.state).toEqual({ kind: 'offline' })
  })

  it('still opens a cached page at once while the dial retries', () => {
    const retrying = gates({ reachability: 'unreachable', retrying: true })
    const step = run(started(retrying).session, { type: 'cache-read', generation: CACHED })
    const offline = gates({ reachability: 'unreachable' })
    const unretried = run(started(offline).session, { type: 'cache-read', generation: CACHED })
    expect(step.session.state).toEqual(unretried.session.state)
    expect(step.effects).toEqual(unretried.effects)
    expect(step.session.state.kind).toBe('activating')
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

  it('walls a check in flight when the host stops serving a bundle', () => {
    const checking = started()
    const step = run(checking.session, {
      type: 'gates-changed',
      gates: gates({ hostCapabilities: [] })
    })
    expect(step.session.state).toEqual(NO_BUNDLE_WALL)
  })
})

// A finished WebView load can still have failed script evaluation; only page ready proves its code ran.
describe('the page has to speak for the document that loaded', () => {
  it('arms nothing when the page spoke first, because there is nothing left to wait for', () => {
    const step = run(readySession().session, { type: 'page-ready' }, { type: 'document-loaded' })
    expect(step.effects).toEqual([])
    expect(step.session.pageReady).toBe(true)
  })

  it('deletes the cache and runs the flow again when the wait expires', () => {
    const ready = run(readySession().session, { type: 'document-loaded' })
    const step = run(ready.session, { type: 'page-ready-deadline' })
    expect(step.effects).toEqual([{ kind: 'delete-cache' }, { kind: 'open-cache' }])
    expect(step.session.retriedOnce).toBe(true)
    expect(step.session.state.kind).toBe('checking')
  })

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
    const spoken = run(readySession().session, { type: 'page-ready' })
    const remounted = run(spoken.session, { type: 'remounted', sessionId: 'session-two' })
    expect(remounted.session.pageReady).toBe(false)
    expect(run(remounted.session, { type: 'document-loaded' }).effects).toEqual([
      { kind: 'await-page-ready' }
    ])
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
  it('deletes the cache and runs the flow again when no document ever finished', () => {
    const started = run(readySession().session, { type: 'document-started' })
    const step = run(started.session, { type: 'document-load-deadline' })
    expect(step.effects).toEqual([{ kind: 'delete-cache' }, { kind: 'open-cache' }])
    expect(step.session.state.kind).toBe('checking')
  })

  it('does nothing once the document finished or the page spoke', () => {
    const loaded = run(readySession().session, { type: 'document-loaded' })
    expect(run(loaded.session, { type: 'document-load-deadline' }).effects).toEqual([])
    const spoke = run(readySession().session, { type: 'page-ready' })
    expect(run(spoke.session, { type: 'document-load-deadline' }).session.state.kind).toBe('ready')
  })

  it('drops the wait a replaced document left behind', () => {
    const ready = readySession()
    const armed = ready.session.flow
    const started = run(ready.session, { type: 'document-started' })
    const step = run(started.session, { type: 'document-load-deadline', flow: armed })
    expect(step.effects).toEqual([])
    expect(step.session.state.kind).toBe('ready')
  })
})

// Neither WebView commit nor page ready proves paint; keep the cover until the page reports a frame.
describe('the page reporting a frame on screen', () => {
  it('keeps the frame covered past ready until the report', () => {
    const spoken = run(readySession().session, { type: 'page-ready' })
    expect(spoken.session.pagePainted).toBe(false)
    expect(shellPageFrame(spoken.session)).toBe('unpainted')
    const painted = run(spoken.session, { type: 'page-painted' })
    expect(painted.session.pagePainted).toBe(true)
    expect(shellPageFrame(painted.session)).toBe('painted')
  })

  it('makes a remounted document report its own frame', () => {
    const painted = run(readySession().session, { type: 'page-ready' }, { type: 'page-painted' })
    const remounted = run(painted.session, { type: 'remounted', sessionId: 'session-two' })
    expect(remounted.session.pagePainted).toBe(false)
    expect(shellPageFrame(remounted.session)).toBe('unpainted')
  })

  it('makes the document that replaced a painted one inside this mount report its own frame', () => {
    const painted = run(readySession().session, { type: 'page-ready' }, { type: 'page-painted' })
    expect(shellPageFrame(painted.session)).toBe('painted')
    const restarted = run(painted.session, { type: 'document-started' })
    expect(restarted.session.pagePainted).toBe(false)
    const reasked = run(restarted.session, { type: 'page-ready' })
    expect(shellPageFrame(reasked.session)).toBe('unpainted')
    expect(shellPageFrame(run(reasked.session, { type: 'page-painted' }).session)).toBe('painted')
  })

  it('retires the wait the document it replaced armed', () => {
    const loaded = run(readySession().session, { type: 'document-loaded' })
    expect(loaded.effects).toEqual([{ kind: 'await-page-ready' }])
    const armed = loaded.session.flow
    const spoken = run(loaded.session, { type: 'page-ready' })
    const restarted = run(spoken.session, { type: 'document-started' })
    const expired = run(restarted.session, { type: 'page-ready-deadline', flow: armed })
    expect(expired.session.state.kind).toBe('ready')
    const reloaded = run(restarted.session, { type: 'document-loaded' })
    expect(reloaded.effects).toEqual([{ kind: 'await-page-ready' }])
  })

  it('keeps the frame of a document that repeats its own handshake', () => {
    const painted = run(
      readySession().session,
      { type: 'page-ready' },
      { type: 'page-painted' },
      { type: 'page-ready' }
    )
    expect(painted.session.pagePainted).toBe(true)
    expect(shellPageFrame(painted.session)).toBe('painted')
  })
})
