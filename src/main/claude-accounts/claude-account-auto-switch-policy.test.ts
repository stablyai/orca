import { describe, expect, it } from 'vitest'
import type { InactiveAccountUsage, ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  CLAUDE_AUTO_SWITCH_COOLDOWN_MS,
  pickClaudeAutoSwitchTarget
} from './claude-account-auto-switch-policy'

function limits(session: number, weekly = 0, status: ProviderRateLimits['status'] = 'ok') {
  const window = (usedPercent: number, windowMinutes: number) => ({
    usedPercent,
    windowMinutes,
    resetsAt: null,
    resetDescription: null
  })
  return {
    provider: 'claude' as const,
    session: window(session, 300),
    weekly: window(weekly, 10_080),
    updatedAt: 0,
    error: null,
    status
  }
}

function usage(accountId: string, rateLimits: ProviderRateLimits): InactiveAccountUsage {
  return { accountId, rateLimits, updatedAt: rateLimits.updatedAt, isFetching: false }
}

// The 5-hour window ended a minute ago, as an idle session's stale report would show it.
function sessionEnded(usedPercent: number): ProviderRateLimits {
  const reading = limits(usedPercent)
  return { ...reading, session: { ...reading.session, resetsAt: NOW - 60_000 } }
}

const NOW = Date.UTC(2026, 9, 12, 9)
const COOLED_DOWN = CLAUDE_AUTO_SWITCH_COOLDOWN_MS

function pick(
  active: ProviderRateLimits,
  candidates: InactiveAccountUsage[],
  msSinceLastSwitch: number
): string | null {
  return pickClaudeAutoSwitchTarget(active, candidates, {
    now: NOW,
    lastSwitchAt: NOW - msSinceLastSwitch
  })
}

describe('pickClaudeAutoSwitchTarget', () => {
  it('stays while the active account is under the line', () => {
    expect(pick(limits(89), [usage('b', limits(0))], COOLED_DOWN)).toBe(null)
  })

  it('moves to the account with the most room once the active account crosses the line', () => {
    const candidates = [usage('b', limits(50)), usage('c', limits(20)), usage('d', limits(35))]

    expect(pick(limits(90), candidates, COOLED_DOWN)).toBe('c')
  })

  it('counts the weekly window as well as the 5-hour one', () => {
    expect(pick(limits(10, 95), [usage('b', limits(10, 10))], COOLED_DOWN)).toBe('b')
  })

  it('ranks candidates by their tightest window', () => {
    const candidates = [usage('b', limits(5, 85)), usage('c', limits(40, 40))]

    expect(pick(limits(92), candidates, COOLED_DOWN)).toBe('c')
  })

  it('stays when the best account is not clearly better', () => {
    expect(pick(limits(91), [usage('b', limits(86))], COOLED_DOWN)).toBe(null)
  })

  it('never moves to an account that is itself over the line before the limit is hit', () => {
    expect(pick(limits(99), [usage('b', limits(90))], COOLED_DOWN)).toBe(null)
  })

  it('skips accounts whose usage could not be read', () => {
    const candidates = [usage('expired', limits(0, 0, 'error')), usage('b', limits(40))]

    expect(pick(limits(95), candidates, COOLED_DOWN)).toBe('b')
  })

  it('stays while the active usage cannot be read', () => {
    expect(pick(limits(100, 0, 'error'), [usage('b', limits(0))], COOLED_DOWN)).toBe(null)
  })

  it('waits out the cooldown after the last switch', () => {
    const candidates = [usage('b', limits(10))]

    expect(pick(limits(95), candidates, COOLED_DOWN - 1)).toBe(null)
  })

  it('at the limit, takes any account with room even during the cooldown', () => {
    const candidates = [usage('b', limits(97)), usage('c', limits(100))]

    expect(pick(limits(100), candidates, 0)).toBe('b')
  })

  it('ignores usage from a window that has already reset', () => {
    expect(pick(sessionEnded(96), [usage('b', limits(0))], COOLED_DOWN)).toBe(null)
  })

  it('counts an account as free again once its window has reset', () => {
    expect(pick(limits(95), [usage('b', sessionEnded(100))], COOLED_DOWN)).toBe('b')
  })

  it('reads an account whose windows have all reset as empty', () => {
    const allEnded = (usedPercent: number): ProviderRateLimits => {
      const reading = limits(usedPercent, usedPercent)
      const ended = { resetsAt: NOW - 60_000 }
      return {
        ...reading,
        session: { ...reading.session, ...ended },
        weekly: { ...reading.weekly, ...ended }
      }
    }

    expect(pick(allEnded(100), [usage('b', limits(0))], COOLED_DOWN)).toBe(null)
    expect(pick(limits(95), [usage('b', allEnded(100))], COOLED_DOWN)).toBe('b')
  })

  it('stays when every account is out', () => {
    const candidates = [usage('b', limits(100)), usage('c', limits(20, 100))]

    expect(pick(limits(100), candidates, COOLED_DOWN)).toBe(null)
  })
})
