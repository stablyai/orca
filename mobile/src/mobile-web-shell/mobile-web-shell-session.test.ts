import { describe, expect, it } from 'vitest'
import {
  readyAgain,
  CACHED,
  MANIFEST,
  awaitingManifest,
  gates,
  readySession,
  run,
  started,
  BUNDLE_REFUSED
} from './mobile-web-shell-session-test-fixtures'
import { shellPageFrame } from './shell-page-frame'

describe('recovery follows the shell view contract', () => {
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
  it('deletes unreadable files and lets the retried generation refetch again', () => {
    const unreadable = { type: 'shell-failed', reason: 'generation-unreadable' } as const
    const lost = run(readySession().session, {
      type: 'shell-failed',
      reason: 'render-process-gone'
    })
    const remounted = run(lost.session, { type: 'remounted', sessionId: 'session-remounted' })
    const first = run(remounted.session, unreadable)
    const refetched = readyAgain(first.session, 'session-two')
    const failed = run(refetched.session, unreadable)
    const retried = run(failed.session, { type: 'retry-pressed' })
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
      }
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
    expect(run(batched.session, { type: 'cache-read', generation: null }).effects).toEqual([
      { kind: 'read-manifest' }
    ])
  })
})

// A finished WebView load can still have failed script evaluation; only page ready proves its code ran.
describe('the page has to speak for the document that loaded', () => {
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
