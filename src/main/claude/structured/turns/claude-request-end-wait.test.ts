import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  awaitClaudeRequestEnd,
  CLAUDE_STOP_GRACE_MS,
  settleClaudeTurnEndWaiters
} from './claude-request-end-wait'
import type { ClaudeSession } from '../claude-structured-session-state'

type InFlight = { translator: { currentTurnId: string | null }; dispatchWaiters: unknown[] }

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

  it('waits on a send Claude has not echoed, through its turn, to that turn’s end', async () => {
    const { claude, state } = claudeWith(null, 1)
    const waiting = awaitClaudeRequestEnd(claude, CLAUDE_STOP_GRACE_MS)
    state.dispatchWaiters.length = 0
    state.translator.currentTurnId = 'turn-1'
    settleClaudeTurnEndWaiters(claude)
    expect(await settledWithin(waiting, 0)).toBe(false)

    state.translator.currentTurnId = null
    settleClaudeTurnEndWaiters(claude)
    expect(await settledWithin(waiting, 0)).toBe(true)
  })
})
