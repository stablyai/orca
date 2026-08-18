import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonPendingRequests } from './daemon-client-pending-requests'
import { requestDaemonRpc } from './daemon-client-rpc-request'

describe('requestDaemonRpc', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a completed spawn result when cancellation arrives too late', async () => {
    const pendingRequests = new DaemonPendingRequests()
    const abort = new AbortController()
    let finishCancellation: (result: { canceled: boolean }) => void = () => {}
    const cancellation = new Promise<{ canceled: boolean }>((resolve) => {
      finishCancellation = resolve
    })
    const request = requestDaemonRpc<{ isNew: boolean }>({
      socket: { write: vi.fn() } as unknown as Socket,
      pendingRequests,
      id: 'req-1',
      type: 'createOrAttach',
      payload: { sessionId: 'completed-spawn' },
      timeoutMs: 30_000,
      signal: abort.signal,
      unmatchedCancelGraceMs: 5_000,
      onCreateCancellationFailure: vi.fn(),
      settleCreateCancellation: () => cancellation
    })

    abort.abort()
    finishCancellation({ canceled: false })
    pendingRequests.settle({ id: 'req-1', ok: true, payload: { isNew: true } })

    await expect(request).resolves.toEqual({ isNew: true })
  })

  it('keeps a completed spawn result when its deadline cancellation arrives too late', async () => {
    vi.useFakeTimers()
    const pendingRequests = new DaemonPendingRequests()
    const settleCreateCancellation = vi.fn(async () => ({ canceled: false }))
    const request = requestDaemonRpc<{ isNew: boolean }>({
      socket: { write: vi.fn() } as unknown as Socket,
      pendingRequests,
      id: 'req-1',
      type: 'createOrAttach',
      payload: { sessionId: 'completed-spawn' },
      timeoutMs: 10,
      unmatchedCancelGraceMs: 5_000,
      onCreateCancellationFailure: vi.fn(),
      settleCreateCancellation
    })

    await vi.advanceTimersByTimeAsync(10)
    expect(settleCreateCancellation).toHaveBeenCalledWith('completed-spawn', 'req-1')
    pendingRequests.settle({ id: 'req-1', ok: true, payload: { isNew: true } })

    await expect(request).resolves.toEqual({ isNew: true })
  })

  it('rejects a timed-out spawn after the daemon confirms cancellation', async () => {
    vi.useFakeTimers()
    const pendingRequests = new DaemonPendingRequests()
    const request = requestDaemonRpc({
      socket: { write: vi.fn() } as unknown as Socket,
      pendingRequests,
      id: 'req-1',
      type: 'createOrAttach',
      payload: { sessionId: 'pending-spawn' },
      timeoutMs: 10,
      unmatchedCancelGraceMs: 5_000,
      onCreateCancellationFailure: vi.fn(),
      settleCreateCancellation: vi.fn(async () => ({ canceled: true }))
    })
    const rejected = expect(request).rejects.toThrow('Request createOrAttach timed out after 10ms')

    await vi.advanceTimersByTimeAsync(10)

    await rejected
    expect(pendingRequests.size).toBe(0)
  })

  it('rejects an unmatched cancellation once the grace window elapses', async () => {
    vi.useFakeTimers()
    const pendingRequests = new DaemonPendingRequests()
    // attach-only: the daemon registers no cancellable spawn, so it can never
    // match the cancel and no response is coming either.
    const request = requestDaemonRpc({
      socket: { write: vi.fn() } as unknown as Socket,
      pendingRequests,
      id: 'req-1',
      type: 'createOrAttach',
      payload: { sessionId: 'attach-only-spawn', attachOnly: true },
      timeoutMs: 10,
      unmatchedCancelGraceMs: 5_000,
      onCreateCancellationFailure: vi.fn(),
      settleCreateCancellation: vi.fn(async () => ({ canceled: false }))
    })
    const rejected = expect(request).rejects.toThrow('Request createOrAttach timed out after 10ms')

    await vi.advanceTimersByTimeAsync(10)
    expect(pendingRequests.size).toBe(1)
    await vi.advanceTimersByTimeAsync(5_000)

    await rejected
    expect(pendingRequests.size).toBe(0)
  })

  it('disconnects when spawn cancellation cannot be confirmed', async () => {
    const pendingRequests = new DaemonPendingRequests()
    const abort = new AbortController()
    const onCreateCancellationFailure = vi.fn(() => {
      pendingRequests.rejectAll('Connection lost')
    })
    const request = requestDaemonRpc({
      socket: { write: vi.fn() } as unknown as Socket,
      pendingRequests,
      id: 'req-1',
      type: 'createOrAttach',
      payload: { sessionId: 'unconfirmed-spawn' },
      timeoutMs: 30_000,
      signal: abort.signal,
      unmatchedCancelGraceMs: 5_000,
      onCreateCancellationFailure,
      settleCreateCancellation: vi.fn(async () => {
        throw new Error('settlement failed')
      })
    })
    const rejected = expect(request).rejects.toThrow('Connection lost')

    abort.abort()

    await rejected
    expect(onCreateCancellationFailure).toHaveBeenCalledOnce()
    expect(pendingRequests.size).toBe(0)
  })
})
