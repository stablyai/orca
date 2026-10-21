import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  awaitClaudeRequestEnd,
  CLAUDE_STOP_GRACE_MS,
  claudeStoppedRequestEndWait,
  settleClaudeTurnEndWaiters
} from './claude-request-end-wait'
import type { ClaudeSession } from './claude-structured-session-state'

type InFlight = { translator: { currentTurnId: string | null }; dispatchWaiters: unknown[] }

// Only what Claude has in flight is read: the wait derives everything else from it. `state` is the
// same object, for the test to move Claude along.
function claudeWith(
  currentTurnId: string | null = 'turn-1',
  unanswered = 0
): { claude: ClaudeSession; state: InFlight } {
  const state: InFlight = {
    translator: { currentTurnId },
    dispatchWaiters: Array.from({ length: unanswered }, () => ({}))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wait reads only `translator.currentTurnId` and `dispatchWaiters`, and keys its waiters by the session's identity.
  return { claude: state as unknown as ClaudeSession, state }
}

function session(currentTurnId: string | null = 'turn-1'): ClaudeSession {
  return claudeWith(currentTurnId).claude
}

async function settledWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  let settled = false
  void promise.then(() => {
    settled = true
  })
  await vi.advanceTimersByTimeAsync(ms)
  return settled
}

describe("a Stop's wait for Claude to wind down what it has in flight", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits out the whole time for a turn Claude never ends', async () => {
    const waiting = awaitClaudeRequestEnd(session(), CLAUDE_STOP_GRACE_MS)

    expect(await settledWithin(waiting, CLAUDE_STOP_GRACE_MS - 1)).toBe(false)
    expect(await settledWithin(waiting, 1)).toBe(true)
  })

  it('ends as soon as the stopped turn ends', async () => {
    const { claude, state } = claudeWith()
    const waiting = awaitClaudeRequestEnd(claude, CLAUDE_STOP_GRACE_MS)
    state.translator.currentTurnId = null
    settleClaudeTurnEndWaiters(claude)

    expect(await settledWithin(waiting, 0)).toBe(true)
  })

  it('waits on a send Claude has not echoed, through its turn, to that turn’s end', async () => {
    const { claude, state } = claudeWith(null, 1)
    const waiting = awaitClaudeRequestEnd(claude, CLAUDE_STOP_GRACE_MS)
    // The echo answers the send and opens its turn; a settle in between leaves it in flight.
    state.dispatchWaiters.length = 0
    state.translator.currentTurnId = 'turn-1'
    settleClaudeTurnEndWaiters(claude)
    expect(await settledWithin(waiting, 0)).toBe(false)

    state.translator.currentTurnId = null
    settleClaudeTurnEndWaiters(claude)
    expect(await settledWithin(waiting, 0)).toBe(true)
  })

  it('holds nothing when Claude has nothing in flight', async () => {
    expect(await settledWithin(awaitClaudeRequestEnd(session(null), 1_000), 0)).toBe(true)
  })

  it('waits only what the interrupt left of the grace, and nothing for a session that is gone', async () => {
    const sessions = new Map([['session-1', session()]])
    const wait = claudeStoppedRequestEndWait(sessions)
    const stoppedAt = Date.now()
    await vi.advanceTimersByTimeAsync(CLAUDE_STOP_GRACE_MS - 1_000)
    const waiting = wait('session-1', stoppedAt)

    expect(await settledWithin(waiting, 999)).toBe(false)
    expect(await settledWithin(waiting, 1)).toBe(true)
    expect(await settledWithin(wait('session-2', Date.now()), 0)).toBe(true)
  })
})
