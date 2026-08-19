import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonPendingRequests } from './daemon-client-pending-requests'
import { requestDaemonRpc } from './daemon-client-rpc-request'
import { isDaemonGoneError } from './daemon-pty-adapter'
import {
  DAEMON_UNAVAILABLE_RECONNECT_MESSAGE,
  DaemonConnectionLostError,
  DaemonProtocolError,
  DaemonRequestTimeoutError
} from './types'

/** Mirrors DaemonClient: a sibling session's in-flight request on the same connection. */
function addSiblingRequest(pendingRequests: DaemonPendingRequests, reject: () => void): void {
  pendingRequests.add('sibling-1', {
    resolve: () => {},
    reject,
    timer: setTimeout(() => {}, 60_000)
  })
}

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

  it('disconnects when the cancel could not be put on the wire', async () => {
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
        throw new DaemonConnectionLostError('Not connected')
      })
    })
    const rejected = expect(request).rejects.toThrow('Connection lost')

    abort.abort()

    await rejected
    expect(onCreateCancellationFailure).toHaveBeenCalledOnce()
    expect(pendingRequests.size).toBe(0)
  })

  describe('cancel failures the daemon itself produced', () => {
    // A cancel the daemon answered — or one that blew its own timeout because the
    // daemon's event loop is blocked — says nothing about the sibling sessions
    // sharing this connection, so it must never tear the connection down.
    async function abortWithFailingCancel(cancelError: Error): Promise<{
      request: Promise<unknown>
      pendingRequests: DaemonPendingRequests
      onCreateCancellationFailure: ReturnType<typeof vi.fn>
      rejectSibling: ReturnType<typeof vi.fn>
    }> {
      const pendingRequests = new DaemonPendingRequests()
      const rejectSibling = vi.fn()
      addSiblingRequest(pendingRequests, rejectSibling)
      const onCreateCancellationFailure = vi.fn(() => {
        pendingRequests.rejectAll('Connection lost')
      })
      const abort = new AbortController()
      const request = requestDaemonRpc({
        socket: { write: vi.fn() } as unknown as Socket,
        pendingRequests,
        id: 'req-1',
        type: 'createOrAttach',
        payload: { sessionId: 'blocked-spawn' },
        timeoutMs: 30_000,
        signal: abort.signal,
        unmatchedCancelGraceMs: 5_000,
        onCreateCancellationFailure,
        settleCreateCancellation: vi.fn(async () => {
          throw cancelError
        })
      })
      abort.abort()
      await vi.advanceTimersByTimeAsync(0)
      return { request, pendingRequests, onCreateCancellationFailure, rejectSibling }
    }

    it('keeps the connection, and stays abort-shaped, when the cancel RPC times out', async () => {
      vi.useFakeTimers()
      // The caller asked to stop, so a wedged daemon must not turn this into a respawn.
      const { request, pendingRequests, onCreateCancellationFailure, rejectSibling } =
        await abortWithFailingCancel(
          new DaemonRequestTimeoutError('Request cancelCreateOrAttach timed out after 5000ms')
        )
      const rejected = expect(request).rejects.toThrow('client_disconnected')

      expect(onCreateCancellationFailure).not.toHaveBeenCalled()
      // Still pending: the bounded grace window, not an immediate teardown.
      expect(pendingRequests.size).toBe(2)

      await vi.advanceTimersByTimeAsync(5_000)

      await rejected
      expect(onCreateCancellationFailure).not.toHaveBeenCalled()
      expect(rejectSibling).not.toHaveBeenCalled()
      expect(pendingRequests.size).toBe(1)
    })

    it('keeps the connection when the daemon answers the cancel with an error', async () => {
      vi.useFakeTimers()
      // v1-v10 daemons have no `cancelCreateOrAttach` case at all.
      const { request, pendingRequests, onCreateCancellationFailure, rejectSibling } =
        await abortWithFailingCancel(
          new DaemonProtocolError('Unknown request type: cancelCreateOrAttach')
        )
      const rejected = expect(request).rejects.toThrow('client_disconnected')

      await vi.advanceTimersByTimeAsync(5_000)

      await rejected
      expect(onCreateCancellationFailure).not.toHaveBeenCalled()
      expect(rejectSibling).not.toHaveBeenCalled()
      expect(pendingRequests.size).toBe(1)
    })
  })

  it('reports a wedged daemon when the request and its cancel both time out', async () => {
    // Why: neither RPC was answered but the socket never closed, so no disconnect fires.
    // The only remaining recovery is rejecting with the message isDaemonGoneError matches,
    // which lets withDaemonRetry respawn instead of retrying forever against a dead loop.
    vi.useFakeTimers()
    const pendingRequests = new DaemonPendingRequests()
    const rejectSibling = vi.fn()
    addSiblingRequest(pendingRequests, rejectSibling)
    const onCreateCancellationFailure = vi.fn(() => {
      pendingRequests.rejectAll('Connection lost')
    })
    const request = requestDaemonRpc({
      socket: { write: vi.fn() } as unknown as Socket,
      pendingRequests,
      id: 'req-1',
      type: 'createOrAttach',
      payload: { sessionId: 'wedged-spawn' },
      timeoutMs: 30_000,
      unmatchedCancelGraceMs: 5_000,
      onCreateCancellationFailure,
      settleCreateCancellation: vi.fn(async () => {
        throw new DaemonRequestTimeoutError('Request cancelCreateOrAttach timed out after 5000ms')
      })
    })
    const rejected = expect(request).rejects.toThrow(DAEMON_UNAVAILABLE_RECONNECT_MESSAGE)

    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(5_000)

    await rejected
    // The whole point: withDaemonRetry only respawns for errors this predicate matches.
    await request.catch((err: unknown) => expect(isDaemonGoneError(err)).toBe(true))
    expect(onCreateCancellationFailure).not.toHaveBeenCalled()
    expect(rejectSibling).not.toHaveBeenCalled()
    expect(pendingRequests.size).toBe(1)
  })

  it('drops the pending entry when the control socket write throws', async () => {
    const pendingRequests = new DaemonPendingRequests()
    const request = requestDaemonRpc({
      socket: {
        write: vi.fn(() => {
          throw new Error('This socket has been ended by the other party')
        })
      } as unknown as Socket,
      pendingRequests,
      id: 'req-1',
      type: 'createOrAttach',
      payload: { sessionId: 'unsendable-spawn' },
      timeoutMs: 30_000,
      unmatchedCancelGraceMs: 5_000,
      onCreateCancellationFailure: vi.fn(),
      settleCreateCancellation: vi.fn(async () => ({ canceled: true }))
    })

    await expect(request).rejects.toThrow('This socket has been ended by the other party')
    expect(pendingRequests.size).toBe(0)
  })
})
