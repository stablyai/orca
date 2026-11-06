import { describe, expect, it } from 'vitest'
import type { InactiveAccountUsage, ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  CLAUDE_POOL_REBALANCE_COOLDOWN_MS,
  CLAUDE_POOL_REBALANCE_MIN_TARGET_HEADROOM,
  CLAUDE_POOL_REBALANCE_QUIET_MS,
  CLAUDE_SESSION_MOVE_BACKGROUND_WAIT_MS,
  CLAUDE_SESSION_MOVE_COOLDOWN_MS,
  CLAUDE_SESSION_MOVE_FAILURE_HOLD_MS,
  CLAUDE_SESSION_MOVE_TARGET_COOLDOWN_MS,
  debitClaimedUsage,
  decideClaudeSessionMove,
  type ClaudeSessionMoveInputs
} from './claude-session-mover-policy'

const NOW = Date.parse('2026-10-19T12:00:00Z')

function limits(usedPercent: number, updatedAt = NOW): ProviderRateLimits {
  return {
    provider: 'claude',
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    updatedAt,
    error: null,
    status: 'ok'
  }
}

function candidate(accountId: string, usedPercent: number, updatedAt = NOW): InactiveAccountUsage {
  return { accountId, rateLimits: limits(usedPercent, updatedAt), updatedAt, isFetching: false }
}

function inputs(overrides: Partial<ClaudeSessionMoveInputs> = {}): ClaudeSessionMoveInputs {
  return {
    now: NOW,
    setting: 'move',
    pinned: false,
    paneState: 'done',
    usage: limits(96),
    candidates: [candidate('b', 50), candidate('c', 20)],
    candidateCount: 2,
    lastUsageReadAt: 0,
    lastMoveAt: 0,
    lastFailureAt: 0,
    targetClaims: new Map(),
    ...overrides
  }
}

describe('decideClaudeSessionMove', () => {
  it('moves an idle session over the line to the account with the most room', () => {
    expect(decideClaudeSessionMove(inputs())).toEqual({
      kind: 'move',
      to: 'c',
      window: { name: 'session', percent: 96, line: 95 }
    })
  })

  it('waits for the turn to end, and for a first status', () => {
    expect(decideClaudeSessionMove(inputs({ paneState: 'working' }))).toEqual({
      kind: 'wait',
      reason: 'mid-turn'
    })
    expect(decideClaudeSessionMove(inputs({ paneState: 'blocked' }))).toEqual({
      kind: 'wait',
      reason: 'mid-turn'
    })
    expect(decideClaudeSessionMove(inputs({ paneState: null }))).toEqual({
      kind: 'wait',
      reason: 'no-status'
    })
  })

  it('moves during a turn when the caller says the move does not need the turn to end', () => {
    expect(decideClaudeSessionMove(inputs({ paneState: 'working', allowMidTurn: true })).kind).toBe(
      'move'
    )
    expect(decideClaudeSessionMove(inputs({ paneState: null, allowMidTurn: true })).kind).toBe(
      'move'
    )
    expect(
      decideClaudeSessionMove(
        inputs({
          paneState: 'done',
          paneBackgroundWork: true,
          backgroundWaitStartedAt: NOW,
          allowMidTurn: true
        })
      ).kind
    ).toBe('move')
  })

  it('does not wait mid-turn when the main agent is done and no background work is alive', () => {
    // paneState is the main agent's state once the session view is collected.
    const decision = decideClaudeSessionMove(inputs({ paneState: 'done' }))
    expect(decision).not.toEqual({ kind: 'wait', reason: 'mid-turn' })
    expect(decision.kind).toBe('move')
  })

  it('holds a done main agent while background work is alive, then moves', () => {
    const waiting = {
      paneState: 'done' as const,
      paneBackgroundWork: true,
      backgroundWaitStartedAt: NOW - CLAUDE_SESSION_MOVE_BACKGROUND_WAIT_MS + 1
    }
    expect(decideClaudeSessionMove(inputs(waiting))).toEqual({
      kind: 'wait',
      reason: 'background-work'
    })
    expect(
      decideClaudeSessionMove(
        inputs({
          ...waiting,
          backgroundWaitStartedAt: NOW - CLAUDE_SESSION_MOVE_BACKGROUND_WAIT_MS
        })
      ).kind
    ).toBe('move')
    expect(decideClaudeSessionMove(inputs({ ...waiting, backgroundWaitStartedAt: 0 })).kind).toBe(
      'wait'
    )
    expect(
      decideClaudeSessionMove(
        inputs({ ...waiting, usage: limits(100), backgroundWaitStartedAt: NOW })
      ).kind
    ).toBe('move')
    expect(
      decideClaudeSessionMove(inputs({ paneState: 'done', paneBackgroundWork: false })).kind
    ).toBe('move')
    expect(
      decideClaudeSessionMove(inputs({ paneState: 'working', paneBackgroundWork: true }))
    ).toEqual({ kind: 'wait', reason: 'mid-turn' })
  })

  it('leaves a pinned session alone until its account is at the limit', () => {
    expect(decideClaudeSessionMove(inputs({ pinned: true, usage: limits(96) }))).toEqual({
      kind: 'stay',
      reason: 'under-line'
    })
    expect(decideClaudeSessionMove(inputs({ pinned: true, usage: limits(100) })).kind).toBe('move')
  })

  it('stays under the line and when the setting is off', () => {
    expect(decideClaudeSessionMove(inputs({ usage: limits(80) }))).toEqual({
      kind: 'stay',
      reason: 'under-line'
    })
    expect(decideClaudeSessionMove(inputs({ setting: 'off' }))).toEqual({
      kind: 'stay',
      reason: 'off'
    })
  })

  it("asks for a reading when the session's usage is stale, then stays until one arrives", () => {
    const stale = limits(96, NOW - 16 * 60_000)
    expect(decideClaudeSessionMove(inputs({ usage: stale }))).toEqual({ kind: 'read-usage' })
    expect(decideClaudeSessionMove(inputs({ usage: stale, lastUsageReadAt: NOW - 1_000 }))).toEqual(
      { kind: 'stay', reason: 'no-usage' }
    )
    expect(decideClaudeSessionMove(inputs({ usage: null }))).toEqual({ kind: 'read-usage' })
  })

  it("waits for every candidate's reading before picking, unless one is unreadable", () => {
    expect(decideClaudeSessionMove(inputs({ candidates: [candidate('b', 50)] }))).toEqual({
      kind: 'read-usage'
    })
    const unreadable: InactiveAccountUsage = {
      ...candidate('c', 20, NOW - 60 * 60_000),
      rateLimits: { ...limits(20, NOW - 60 * 60_000), usageMetadata: { retryAtMs: NOW + 60_000 } }
    }
    expect(
      decideClaudeSessionMove(inputs({ candidates: [candidate('b', 50), unreadable] }))
    ).toMatchObject({ kind: 'move', to: 'b' })
  })

  it('honours the per-session cooldown and the failure hold, except at the limit', () => {
    expect(
      decideClaudeSessionMove(inputs({ lastMoveAt: NOW - CLAUDE_SESSION_MOVE_COOLDOWN_MS + 1 }))
    ).toEqual({ kind: 'stay', reason: 'cooldown' })
    expect(
      decideClaudeSessionMove(
        inputs({ lastMoveAt: NOW - CLAUDE_SESSION_MOVE_COOLDOWN_MS + 1, usage: limits(100) })
      ).kind
    ).toBe('move')
    expect(
      decideClaudeSessionMove(
        inputs({ lastFailureAt: NOW - CLAUDE_SESSION_MOVE_FAILURE_HOLD_MS + 1 })
      )
    ).toEqual({ kind: 'stay', reason: 'failed-recently' })
    expect(
      decideClaudeSessionMove(inputs({ lastFailureAt: NOW - CLAUDE_SESSION_MOVE_FAILURE_HOLD_MS }))
        .kind
    ).toBe('move')
  })

  it('skips a target another session just claimed, then ranks it with the claim debited', () => {
    const claims = new Map([['c', { at: NOW - 1_000, debit: 5 }]])
    expect(decideClaudeSessionMove(inputs({ targetClaims: claims }))).toMatchObject({
      kind: 'move',
      to: 'b'
    })
    const older = new Map([['c', { at: NOW - CLAUDE_SESSION_MOVE_TARGET_COOLDOWN_MS, debit: 40 }]])
    // c reads 20 + 40 = 60 after the debit, so b (50) has more room.
    expect(decideClaudeSessionMove(inputs({ targetClaims: older }))).toMatchObject({
      kind: 'move',
      to: 'b'
    })
    expect(
      debitClaimedUsage(candidate('c', 20), { at: NOW - 1_000, debit: 5 }, NOW).rateLimits?.session
        ?.usedPercent
    ).toBe(25)
    expect(
      debitClaimedUsage(candidate('c', 98), { at: NOW - 1_000, debit: 5 }, NOW).rateLimits?.session
        ?.usedPercent
    ).toBe(100)
  })

  it('stays when no account has enough room', () => {
    expect(
      decideClaudeSessionMove(inputs({ candidates: [candidate('b', 90), candidate('c', 88)] }))
    ).toEqual({ kind: 'stay', reason: 'no-target' })
  })
})

/** Session window only: headroom is 95 minus used percent. 60% used leaves 35; 5% used leaves 90. */
function spread(overrides: Partial<ClaudeSessionMoveInputs> = {}): ClaudeSessionMoveInputs {
  return inputs({
    usage: limits(60),
    candidates: [candidate('b', 50), candidate('c', 5)],
    pool: { enabled: true, spreadLine: true },
    paneState: 'done',
    turnEndedAt: NOW - CLAUDE_POOL_REBALANCE_QUIET_MS,
    ...overrides
  })
}

describe('decideClaudeSessionMove pool rebalance', () => {
  it('moves a proxy session before the 95/90 lines when the pool is spread and the gap is wide', () => {
    expect(decideClaudeSessionMove(spread())).toEqual({
      kind: 'move',
      to: 'c',
      window: { name: 'session', percent: 60, line: 95 },
      reason: 'rebalance'
    })
  })

  it('keeps the 95/90 lines when the pool is off, the session would restart, or it is pinned', () => {
    expect(decideClaudeSessionMove(spread({ pool: { enabled: false, spreadLine: true } }))).toEqual(
      { kind: 'stay', reason: 'under-line' }
    )
    expect(decideClaudeSessionMove(spread({ pool: { enabled: true, spreadLine: false } }))).toEqual(
      { kind: 'stay', reason: 'under-line' }
    )
    expect(decideClaudeSessionMove(spread({ pool: undefined }))).toEqual({
      kind: 'stay',
      reason: 'under-line'
    })
    expect(decideClaudeSessionMove(spread({ pinned: true }))).toEqual({
      kind: 'stay',
      reason: 'under-line'
    })
    expect(decideClaudeSessionMove(spread({ pinned: true, usage: limits(100) })).kind).toBe('move')
    expect(
      decideClaudeSessionMove(spread({ pinned: true, usage: limits(100) }))
    ).not.toHaveProperty('reason', 'rebalance')
  })

  it('stays when the gap is not wider than 25 points or the best account has under 30 points of room', () => {
    // 30% used → headroom 65, which is not under 90 - 25.
    expect(decideClaudeSessionMove(spread({ usage: limits(30) }))).toEqual({
      kind: 'stay',
      reason: 'under-line'
    })
    const tight = 95 - (CLAUDE_POOL_REBALANCE_MIN_TARGET_HEADROOM - 1)
    expect(
      decideClaudeSessionMove(
        spread({ usage: limits(92), candidates: [candidate('b', tight), candidate('c', tight)] })
      )
    ).toEqual({ kind: 'stay', reason: 'under-line' })
    // Best headroom is exactly 30 (used 65) and own headroom is 4 (used 91): 4 < 30 - 25.
    expect(
      decideClaudeSessionMove(
        spread({
          usage: limits(91),
          candidates: [candidate('b', 80), candidate('c', 65)],
          candidateCount: 2
        })
      )
    ).toMatchObject({ kind: 'move', to: 'c', reason: 'rebalance' })
  })

  it('does not rebalance during a turn or within two minutes of one, unless the hard line is already crossed', () => {
    expect(decideClaudeSessionMove(spread({ paneState: 'working', allowMidTurn: true }))).toEqual({
      kind: 'stay',
      reason: 'under-line'
    })
    expect(decideClaudeSessionMove(spread({ paneState: null, allowMidTurn: true }))).toEqual({
      kind: 'stay',
      reason: 'under-line'
    })
    expect(
      decideClaudeSessionMove(spread({ turnEndedAt: NOW - CLAUDE_POOL_REBALANCE_QUIET_MS + 1 }))
    ).toEqual({ kind: 'stay', reason: 'prompt-cache' })
    expect(decideClaudeSessionMove(spread({ turnEndedAt: undefined }))).toMatchObject({
      kind: 'move',
      reason: 'rebalance'
    })
    expect(
      decideClaudeSessionMove(
        spread({
          usage: limits(96),
          paneState: 'working',
          allowMidTurn: true,
          turnEndedAt: NOW - 1_000
        })
      )
    ).toEqual({
      kind: 'move',
      to: 'c',
      window: { name: 'session', percent: 96, line: 95 }
    })
    expect(
      decideClaudeSessionMove(
        spread({ usage: limits(96), paneState: 'done', turnEndedAt: NOW - 1_000 })
      ).kind
    ).toBe('move')
  })

  it('rate-limits a rebalance to 15 minutes and still moves at the hard line on the shorter cooldown', () => {
    expect(
      decideClaudeSessionMove(spread({ lastMoveAt: NOW - CLAUDE_POOL_REBALANCE_COOLDOWN_MS + 1 }))
    ).toEqual({ kind: 'stay', reason: 'cooldown' })
    expect(
      decideClaudeSessionMove(spread({ lastMoveAt: NOW - CLAUDE_POOL_REBALANCE_COOLDOWN_MS })).kind
    ).toBe('move')
    expect(
      decideClaudeSessionMove(
        spread({
          usage: limits(96),
          lastMoveAt: NOW - CLAUDE_SESSION_MOVE_COOLDOWN_MS,
          turnEndedAt: NOW - 1_000
        })
      ).kind
    ).toBe('move')
    expect(
      decideClaudeSessionMove(
        spread({
          usage: limits(96),
          lastMoveAt: NOW - CLAUDE_SESSION_MOVE_COOLDOWN_MS + 1
        })
      )
    ).toEqual({ kind: 'stay', reason: 'cooldown' })
    expect(
      decideClaudeSessionMove(
        spread({ usage: limits(100), lastMoveAt: NOW - 1_000, allowMidTurn: true })
      ).kind
    ).toBe('move')
  })

  it('holds a rebalance after a failure and still debits or skips a claimed target', () => {
    expect(
      decideClaudeSessionMove(
        spread({ lastFailureAt: NOW - CLAUDE_SESSION_MOVE_FAILURE_HOLD_MS + 1 })
      )
    ).toEqual({ kind: 'stay', reason: 'failed-recently' })
    const claimed = new Map([['c', { at: NOW - 1_000, debit: 5 }]])
    expect(decideClaudeSessionMove(spread({ targetClaims: claimed }))).toEqual({
      kind: 'stay',
      reason: 'under-line'
    })
    expect(
      decideClaudeSessionMove(
        spread({
          targetClaims: claimed,
          candidates: [candidate('b', 5), candidate('c', 5)]
        })
      )
    ).toMatchObject({ kind: 'move', to: 'b', reason: 'rebalance' })
    // c at 5% plus a 40 point debit has headroom 50. Own headroom 35 is not 25 behind that.
    const debited = new Map([
      ['c', { at: NOW - CLAUDE_SESSION_MOVE_TARGET_COOLDOWN_MS, debit: 40 }]
    ])
    expect(decideClaudeSessionMove(spread({ targetClaims: debited }))).toEqual({
      kind: 'stay',
      reason: 'under-line'
    })
  })

  it('asks for a candidate reading before rebalancing, and does not while the cache is still warm', () => {
    expect(
      decideClaudeSessionMove(spread({ candidates: [candidate('c', 5)], candidateCount: 2 }))
    ).toEqual({ kind: 'read-usage' })
    expect(
      decideClaudeSessionMove(
        spread({
          candidates: [candidate('c', 5, NOW - 16 * 60_000)],
          candidateCount: 1,
          turnEndedAt: NOW - 1_000
        })
      )
    ).toEqual({ kind: 'stay', reason: 'prompt-cache' })
  })
})
