import { describe, expect, it, vi } from 'vitest'
import { dispatchClaudeTurn } from './claude-structured-dispatch'
import { resolveClaudeReplayTurn } from './claude-replay-turn-resolution'
import { sessionFor, userMessage, userReplayFrame } from './claude-structured-dispatch-test-support'

function resolveClaudeReplayWaiter(...args: Parameters<typeof resolveClaudeReplayTurn>): boolean {
  return resolveClaudeReplayTurn(...args) !== null
}

describe('Claude structured dispatch admission', () => {
  it('opens queued exact replays with the origin and the send owned by each send', async () => {
    const session = sessionFor()
    await dispatchClaudeTurn(session, {
      clientMessageId: 'client-a',
      body: userMessage([{ type: 'text', text: 'a' }]),
      requestedAt: 100
    })
    const aUuid = session.dispatchWaiters[0]!.sentUuid
    expect(resolveClaudeReplayTurn(session, userReplayFrame(aUuid, 'a'))).toEqual({
      requestedAt: 100,
      clientMessageId: 'client-a'
    })

    await dispatchClaudeTurn(session, {
      clientMessageId: 'client-b',
      body: userMessage([{ type: 'text', text: 'b' }]),
      requestedAt: 200
    })
    await dispatchClaudeTurn(session, {
      clientMessageId: 'client-c',
      body: userMessage([{ type: 'text', text: 'c' }]),
      requestedAt: 300
    })
    const [b, c] = session.dispatchWaiters

    expect(resolveClaudeReplayTurn(session, userReplayFrame(b!.sentUuid, 'b'))).toEqual({
      requestedAt: 200,
      clientMessageId: 'client-b'
    })
    expect(resolveClaudeReplayTurn(session, userReplayFrame(c!.sentUuid, 'c'))).toEqual({
      requestedAt: 300,
      clientMessageId: 'client-c'
    })
  })

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

      expect(resolveClaudeReplayWaiter(session, userReplayFrame(queuedUuid, 'two'), settled)).toBe(
        true
      )
      expect(settled).toHaveBeenLastCalledWith({
        clientMessageId: 'client-2',
        providerIdentity: { provider: 'claude', sessionId: 'provider-session', uuid: queuedUuid }
      })
      expect(session.dispatchWaiters).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
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
    ).resolves.toEqual({
      state: 'rejected',
      reason: 'claude structured dispatch queue is full',
      rejection: { kind: 'queueFull' }
    })
    expect(session.dispatchWaiters).toHaveLength(64)
    expect(session.connection.send).toHaveBeenCalledTimes(64)
  })
})
