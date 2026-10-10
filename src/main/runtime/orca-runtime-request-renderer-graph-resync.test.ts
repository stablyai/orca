import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ipcMainOnMock, ipcMainRemoveMock } = vi.hoisted(() => ({
  ipcMainOnMock: vi.fn(),
  ipcMainRemoveMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { on: ipcMainOnMock, removeListener: ipcMainRemoveMock }
}))

import { OrcaRuntimeWithCollectMobileVisibleGraphChangedWorktrees } from './orca-runtime-collect-mobile-visible-graph-changed-worktrees'

type ReplyHandler = (event: unknown, reply: { requestId: string; ok?: boolean }) => void

// Why: the runtime class is a deep mechanical split; exercise the gate + round
// trip on a bare prototype instance with only the fields the method touches,
// avoiding the full constructor chain.
function makeRuntime(overrides: Record<string, unknown> = {}): {
  runtime: InstanceType<typeof OrcaRuntimeWithCollectMobileVisibleGraphChangedWorktrees>
  send: ReturnType<typeof vi.fn>
} {
  const send = vi.fn()
  const win = { isDestroyed: () => false, webContents: { send } }
  const runtime = Object.create(
    OrcaRuntimeWithCollectMobileVisibleGraphChangedWorktrees.prototype
  ) as InstanceType<typeof OrcaRuntimeWithCollectMobileVisibleGraphChangedWorktrees>
  Object.assign(runtime, {
    forceResyncedMobileWorktrees: new Set<string>(),
    resyncInFlightMobileWorktrees: new Set<string>(),
    resyncAttemptsByMobileWorktree: new Map<string, number>(),
    forceAcceptNextRendererPublish: new Set<string>(),
    acceptedRendererMobileSnapshotByWorktree: new Map<string, unknown>(),
    getAvailableAuthoritativeWindow: () => win,
    ...overrides
  })
  return { runtime, send }
}

describe('requestRendererGraphResync gate + round trip', () => {
  beforeEach(() => {
    ipcMainOnMock.mockReset()
    ipcMainRemoveMock.mockReset()
    vi.useRealTimers()
  })

  it('sends one resync and resolves when the matching reply lands, marking the worktree', async () => {
    const handlerRef: { current: ReplyHandler | null } = { current: null }
    ipcMainOnMock.mockImplementation((..._args: unknown[]) => {
      handlerRef.current = _args[1] as ReplyHandler
    })
    const { runtime, send } = makeRuntime()

    const pending = (
      runtime as unknown as { requestRendererGraphResync: (w: string) => Promise<void> }
    ).requestRendererGraphResync('wt-1')

    expect(send).toHaveBeenCalledTimes(1)
    const [channel, payload] = send.mock.calls[0] as [string, { requestId: string; worktreeId: string }]
    expect(channel).toBe('browser:requestGraphResync')
    expect(payload.worktreeId).toBe('wt-1')
    // The worktree is flagged so main's same-version dedup accepts the resend.
    expect(
      (
        runtime as unknown as { forceAcceptNextRendererPublish: Set<string> }
      ).forceAcceptNextRendererPublish.has('wt-1')
    ).toBe(true)

    // A non-matching requestId is ignored; only the correct one resolves.
    const senderWin = (
      runtime as unknown as { getAvailableAuthoritativeWindow: () => { webContents: unknown } }
    ).getAvailableAuthoritativeWindow()
    handlerRef.current?.({ sender: senderWin.webContents }, { requestId: 'nope', ok: true })
    handlerRef.current?.({ sender: senderWin.webContents }, { requestId: payload.requestId, ok: true })

    await pending
    expect(ipcMainRemoveMock).toHaveBeenCalled()
    expect(
      (runtime as unknown as { forceResyncedMobileWorktrees: Set<string> }).forceResyncedMobileWorktrees.has(
        'wt-1'
      )
    ).toBe(true)
  })

  it('still resyncs when main already holds an accepted snapshot (it may lack browser pages)', async () => {
    // Regression: gating on the accepted snapshot skipped the resync exactly when
    // the desktop's renderer-owned browser pages were missing (accepted snapshot
    // carried terminals only). The resync must run regardless of that snapshot.
    const handlerRef: { current: ReplyHandler | null } = { current: null }
    ipcMainOnMock.mockImplementation((..._args: unknown[]) => {
      handlerRef.current = _args[1] as ReplyHandler
    })
    const { runtime, send } = makeRuntime({
      acceptedRendererMobileSnapshotByWorktree: new Map([['wt-1', {}]])
    })
    const pending = (
      runtime as unknown as { requestRendererGraphResync: (w: string) => Promise<void> }
    ).requestRendererGraphResync('wt-1')
    expect(send).toHaveBeenCalledTimes(1)
    const payload = send.mock.calls[0][1] as { requestId: string }
    const winContents = (
      runtime as unknown as { getAvailableAuthoritativeWindow: () => { webContents: unknown } }
    ).getAvailableAuthoritativeWindow().webContents
    handlerRef.current?.({ sender: winContents }, { requestId: payload.requestId, ok: true })
    await pending
  })

  it('resyncs a worktree at most once per session', async () => {
    ipcMainOnMock.mockImplementation((_ch: string, h: ReplyHandler) => {
      // Reply synchronously on the next microtask with whatever id was sent.
      queueMicrotask(() => {
        const call = sendRef.mock.calls.at(-1) as [string, { requestId: string }] | undefined
        if (call) {
          h({ sender: winContents }, { requestId: call[1].requestId, ok: true })
        }
      })
    })
    const { runtime, send } = makeRuntime()
    const sendRef = send
    const winContents = (
      runtime as unknown as { getAvailableAuthoritativeWindow: () => { webContents: unknown } }
    ).getAvailableAuthoritativeWindow().webContents

    const rrgr = (
      runtime as unknown as { requestRendererGraphResync: (w: string) => Promise<void> }
    ).requestRendererGraphResync.bind(runtime)
    await rrgr('wt-1')
    await rrgr('wt-1')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('leaves a timed-out first resync retryable instead of marking it done', async () => {
    vi.useFakeTimers()
    // Never replies -> the 10s timeout fires.
    ipcMainOnMock.mockImplementation(() => {})
    const { runtime, send } = makeRuntime()
    const rrgr = (
      runtime as unknown as { requestRendererGraphResync: (w: string) => Promise<void> }
    ).requestRendererGraphResync.bind(runtime)

    const p1 = rrgr('wt-1')
    expect(send).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(10_000)
    await p1
    // Not marked done, so a later list can retry (symmetric with the no-window path).
    expect(
      (runtime as unknown as { forceResyncedMobileWorktrees: Set<string> }).forceResyncedMobileWorktrees.has(
        'wt-1'
      )
    ).toBe(false)
    // The force-accept marker must not linger past a failed resync, or an unrelated
    // later publication would wrongly bypass the same-version dedup.
    expect(
      (
        runtime as unknown as { forceAcceptNextRendererPublish: Set<string> }
      ).forceAcceptNextRendererPublish.has('wt-1')
    ).toBe(false)

    const p2 = rrgr('wt-1')
    expect(send).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(10_000)
    await p2
    vi.useRealTimers()
  })

  it('stops retrying after the attempt cap so a dead renderer is not polled forever', async () => {
    vi.useFakeTimers()
    ipcMainOnMock.mockImplementation(() => {}) // never replies
    const { runtime, send } = makeRuntime()
    const rrgr = (
      runtime as unknown as { requestRendererGraphResync: (w: string) => Promise<void> }
    ).requestRendererGraphResync.bind(runtime)

    // Three attempts each time out.
    for (let i = 0; i < 3; i++) {
      const p = rrgr('wt-1')
      await vi.advanceTimersByTimeAsync(10_000)
      await p
    }
    expect(send).toHaveBeenCalledTimes(3)

    // Fourth call is capped: no further round trip.
    await rrgr('wt-1')
    expect(send).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })

  it('no-ops without an authoritative window', async () => {
    const { runtime, send } = makeRuntime({ getAvailableAuthoritativeWindow: () => null })
    await (
      runtime as unknown as { requestRendererGraphResync: (w: string) => Promise<void> }
    ).requestRendererGraphResync('wt-1')
    expect(send).not.toHaveBeenCalled()
  })
})
