// The contract the admission fix exists for: dispatch settles when the write
// completes, and nothing about elapsed time ever puts a message in doubt.

import { describe, expect, it, vi } from 'vitest'
import { dispatchClaudeTurn, resolveClaudeReplayWaiter } from './claude-structured-dispatch'
import {
  childExited,
  sessionFor,
  userMessage,
  userReplayFrame
} from './claude-structured-dispatch-test-support'

describe('Claude structured dispatch admission', () => {
  it('settles a send queued behind a running turn when that turn starts, with no doubt in between', async () => {
    vi.useFakeTimers()
    try {
      const session = sessionFor()
      const settled = vi.fn()
      const running = await dispatchClaudeTurn(session, {
        clientMessageId: 'client-1',
        body: userMessage([{ type: 'text', text: 'one' }])
      })
      const runningUuid = session.dispatchWaiters[0]!.sentUuid
      expect(resolveClaudeReplayWaiter(session, userReplayFrame(runningUuid, 'one'), settled)).toBe(
        true
      )

      // Queued while turn one is still running: Claude cannot echo it until that
      // turn ends, so nothing about the wait is evidence of a delivery problem.
      const queued = await dispatchClaudeTurn(session, {
        clientMessageId: 'client-2',
        body: userMessage([{ type: 'text', text: 'two' }])
      })
      const queuedUuid = session.dispatchWaiters[0]!.sentUuid
      expect(running).toEqual({ state: 'admitted' })
      expect(queued).toEqual({ state: 'admitted' })

      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(session.dispatchWaiters).toHaveLength(1)
      expect(session.retiredDispatchWaiters).toHaveLength(0)
      expect(settled).toHaveBeenCalledTimes(1)

      // Turn one ends and turn two starts: the echo lands and settles the send.
      expect(resolveClaudeReplayWaiter(session, userReplayFrame(queuedUuid, 'two'), settled)).toBe(
        true
      )
      expect(settled).toHaveBeenLastCalledWith({
        clientMessageId: 'client-2',
        providerIdentity: { provider: 'claude', sessionId: 'provider-session', uuid: queuedUuid }
      })
      expect(session.activeTurnId).toBe(queuedUuid)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns as soon as the write completes, without awaiting the echo', async () => {
    const session = sessionFor()
    await expect(
      dispatchClaudeTurn(session, {
        clientMessageId: 'client-1',
        body: userMessage([{ type: 'text', text: 'one' }])
      })
    ).resolves.toEqual({ state: 'admitted' })
    expect(session.connection.send).toHaveBeenCalledTimes(1)
    // Still unacknowledged, and deliberately so: the waiter outlives the call.
    expect(session.dispatchWaiters).toHaveLength(1)
    expect(session.dispatchWaiters[0]!.settledUuid).toBeUndefined()
  })

  it('resolves every live waiter and retires it when the child exits', async () => {
    const session = sessionFor()
    await dispatchClaudeTurn(session, {
      clientMessageId: 'client-1',
      body: userMessage([{ type: 'text', text: 'one' }])
    })
    await dispatchClaudeTurn(session, {
      clientMessageId: 'client-2',
      body: userMessage([{ type: 'text', text: 'two' }])
    })
    expect(session.dispatchWaiters).toHaveLength(2)

    childExited(session)

    expect(session.dispatchWaiters).toHaveLength(0)
    expect(session.retiredDispatchWaiters).toHaveLength(2)
    expect(session.retiredDispatchWaiters.every((waiter) => waiter.retired === true)).toBe(true)
  })

  it('bounds pending replay identities instead of retaining an unbounded queue', async () => {
    const session = sessionFor()
    for (let index = 0; index < 64; index += 1) {
      await expect(
        dispatchClaudeTurn(session, {
          clientMessageId: `client-${index}`,
          body: userMessage([{ type: 'text', text: String(index) }])
        })
      ).resolves.toEqual({ state: 'admitted' })
    }

    await expect(
      dispatchClaudeTurn(session, {
        clientMessageId: 'client-over-capacity',
        body: userMessage([{ type: 'text', text: 'one too many' }])
      })
    ).resolves.toEqual({ state: 'rejected', reason: 'claude structured dispatch queue is full' })
    expect(session.dispatchWaiters).toHaveLength(64)
    expect(session.connection.send).toHaveBeenCalledTimes(64)
  })

  it('does not publish a journal settlement for a provider-control turn', async () => {
    const session = sessionFor()
    const settled = vi.fn()
    await dispatchClaudeTurn(session, {
      body: userMessage([{ type: 'text', text: '/compact' }])
    })
    const uuid = session.dispatchWaiters[0]!.sentUuid

    resolveClaudeReplayWaiter(session, userReplayFrame(uuid, '/compact'), settled)

    expect(settled).not.toHaveBeenCalled()
  })
})
