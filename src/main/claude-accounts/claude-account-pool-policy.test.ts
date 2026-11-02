import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { DEFAULT_POLL_MS } from '../rate-limits/service/service-types'
import {
  CLAUDE_POOL_MIN_HEADROOM_PTS,
  chooseClaudePoolAccount,
  type ClaudePoolAccount,
  type ClaudePoolUsage
} from './claude-account-pool-policy'

const NOW = Date.UTC(2026, 9, 29, 12)

function window(usedPercent: number, windowMinutes: number, resetsAt: number | null = null) {
  return { usedPercent, windowMinutes, resetsAt, resetDescription: null }
}

function limits(
  session: number,
  weekly = 0,
  extra: Partial<ProviderRateLimits> = {}
): ProviderRateLimits {
  return {
    provider: 'claude',
    session: window(session, 300),
    weekly: window(weekly, 10_080),
    updatedAt: NOW,
    error: null,
    status: 'ok',
    ...extra
  }
}

function account(id: string, extra: Partial<ClaudePoolAccount> = {}): ClaudePoolAccount {
  return { id, signedIn: true, ...extra }
}

function usage(
  accountId: string,
  rateLimits: ProviderRateLimits | null,
  updatedAt = NOW
): ClaudePoolUsage {
  return { accountId, rateLimits, updatedAt }
}

function choose(
  accounts: ClaudePoolAccount[],
  rows: ClaudePoolUsage[],
  extra: {
    pinnedCounts?: Record<string, number>
    assignedCounts?: Record<string, number>
    now?: number
  } = {}
) {
  return chooseClaudePoolAccount({
    accounts,
    usage: rows,
    now: extra.now ?? NOW,
    pinnedCounts: extra.pinnedCounts ?? {},
    assignedCounts: extra.assignedCounts ?? {}
  })
}

describe('chooseClaudePoolAccount', () => {
  it('picks the account with the greatest headroom across the 5-hour, weekly, and Fable windows', () => {
    const fableTight = limits(10, 0, { fableWeekly: window(80, 10_080) })
    expect(
      choose(
        [account('a', { selected: true }), account('b'), account('c')],
        [usage('a', limits(40)), usage('b', limits(10, 70)), usage('c', fableTight)]
      )
    ).toEqual({ accountId: 'a', kind: 'chosen' })
    // b's weekly window (90 - 70 = 20) is tighter than its 5-hour window, and tighter than c's Fable window (10).
    expect(
      choose(
        [account('a', { selected: true }), account('b'), account('c')],
        [usage('a', limits(80)), usage('b', limits(10, 70)), usage('c', fableTight)]
      )
    ).toEqual({ accountId: 'b', kind: 'chosen' })
  })

  it('treats a window that has already reset as empty, the same way auto-switch does', () => {
    const reset = limits(100)
    reset.session = window(100, 300, NOW - 60_000)
    expect(
      choose(
        [account('a', { selected: true }), account('b')],
        [usage('a', reset), usage('b', limits(40))]
      )
    ).toEqual({ accountId: 'a', kind: 'chosen' })
  })

  it('breaks a headroom tie by the fewest assigned sessions, then by stable order', () => {
    const rows = [usage('a', limits(20)), usage('b', limits(20)), usage('c', limits(20))]
    expect(
      choose([account('a'), account('b', { selected: true }), account('c')], rows, {
        assignedCounts: { a: 2, b: 0, c: 0 }
      })
    ).toEqual({ accountId: 'b', kind: 'chosen' })
    expect(
      choose([account('c'), account('a', { selected: true }), account('b')], rows, {
        assignedCounts: { a: 1, b: 1, c: 1 }
      })
    ).toEqual({ accountId: 'c', kind: 'chosen' })
  })

  it('skips a stale candidate and falls back to the selected account when every candidate is stale', () => {
    const staleAt = NOW - DEFAULT_POLL_MS - 1
    expect(
      choose(
        [account('a', { selected: true }), account('b')],
        [usage('a', limits(80), staleAt), usage('b', limits(0))]
      )
    ).toEqual({ accountId: 'b', kind: 'chosen' })
    expect(
      choose(
        [account('a', { selected: true }), account('b')],
        [usage('a', limits(0), staleAt), usage('b', limits(0), staleAt)]
      )
    ).toEqual({ accountId: 'a', kind: 'fallback' })
    expect(
      choose([account('a', { selected: true }), account('b')], [usage('b', limits(0))])
    ).toEqual({ accountId: 'b', kind: 'chosen' })
  })

  it('excludes an account that has a hand-pinned session', () => {
    expect(
      choose(
        [account('a', { selected: true }), account('b')],
        [usage('a', limits(0)), usage('b', limits(40))],
        { pinnedCounts: { a: 1 } }
      )
    ).toEqual({ accountId: 'b', kind: 'chosen' })
    expect(
      choose(
        [account('a', { selected: true }), account('b')],
        [usage('a', limits(0), NOW - DEFAULT_POLL_MS - 1), usage('b', limits(40))],
        { pinnedCounts: { b: 2 } }
      )
    ).toEqual({ accountId: 'a', kind: 'fallback' })
  })

  it('skips an account under the minimum headroom, a signed-out account, and one in a failure hold', () => {
    expect(CLAUDE_POOL_MIN_HEADROOM_PTS).toBe(10)
    // Session line is 95, so 86 used leaves 9 points and 80 used leaves 15.
    expect(
      choose(
        [account('a', { selected: true }), account('b'), account('c')],
        [usage('a', limits(86)), usage('b', limits(80)), usage('c', limits(90))]
      )
    ).toEqual({ accountId: 'b', kind: 'chosen' })
    expect(
      choose(
        [account('a', { selected: true }), account('b')],
        [usage('a', limits(86)), usage('b', limits(88))]
      )
    ).toEqual({ accountId: 'a', kind: 'fallback' })
    expect(
      choose(
        [account('a', { selected: true, signedIn: false }), account('b')],
        [usage('a', limits(0)), usage('b', limits(40))]
      )
    ).toEqual({ accountId: 'b', kind: 'chosen' })
    expect(
      choose(
        [account('a', { failureHoldUntil: NOW + 1 }), account('b', { selected: true })],
        [usage('a', limits(0)), usage('b', limits(40))]
      )
    ).toEqual({ accountId: 'b', kind: 'chosen' })
    expect(
      choose(
        [account('a', { failureHoldUntil: NOW }), account('b', { selected: true })],
        [usage('a', limits(0)), usage('b', limits(40))]
      )
    ).toEqual({ accountId: 'a', kind: 'chosen' })
  })

  it('returns null when nothing is selected and nothing can be ranked', () => {
    expect(choose([account('a', { signedIn: false })], [])).toBeNull()
  })
})
