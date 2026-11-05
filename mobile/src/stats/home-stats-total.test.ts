import { describe, expect, it } from 'vitest'
import { translate } from '../i18n/mobile-i18n'
import { formatHomeAgentTime, totalHomeStats } from './home-stats-total'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('totalHomeStats', () => {
  it('sums every desktop instead of letting the last reply win', () => {
    const total = totalHomeStats(
      {
        'host-1': { totalAgentsSpawned: 10, totalPRsCreated: 2, totalAgentTimeMs: 60_000 },
        'host-2': { totalAgentsSpawned: 5, totalPRsCreated: 1, totalAgentTimeMs: 30_000 }
      },
      ['host-1', 'host-2']
    )
    expect(total).toEqual({ totalAgentsSpawned: 15, totalPRsCreated: 3, totalAgentTimeMs: 90_000 })
  })

  it('leaves out a desktop that is no longer paired', () => {
    const byHost = {
      'host-1': { totalAgentsSpawned: 10, totalPRsCreated: 2, totalAgentTimeMs: 60_000 },
      'host-2': { totalAgentsSpawned: 5, totalPRsCreated: 1, totalAgentTimeMs: 30_000 }
    }
    expect(totalHomeStats(byHost, ['host-1'])?.totalAgentsSpawned).toBe(10)
    expect(totalHomeStats(byHost, [])).toBeNull()
  })

  it('has no stats until a desktop sends a number', () => {
    expect(totalHomeStats({}, ['host-1'])).toBeNull()
    // A desktop without stats answers `{}`; that is not a row of zeros.
    expect(totalHomeStats({ 'host-1': {} }, ['host-1'])).toBeNull()
  })

  it('skips a malformed reply and keeps the other desktops', () => {
    const total = totalHomeStats(
      {
        'host-1': { totalAgentsSpawned: 10, totalPRsCreated: 2, totalAgentTimeMs: 60_000 },
        'host-2': null,
        'host-3': { totalAgentsSpawned: 'lots' },
        'host-4': { totalAgentsSpawned: Number.NaN, totalPRsCreated: 1 }
      },
      ['host-1', 'host-2', 'host-3', 'host-4']
    )
    expect(total).toEqual({ totalAgentsSpawned: 10, totalPRsCreated: 3, totalAgentTimeMs: 60_000 })
  })
})

describe('formatHomeAgentTime', () => {
  it('shows whole days once there is a day, without the hours', () => {
    expect(formatHomeAgentTime(139 * DAY + 7 * HOUR + 30 * MINUTE, translate)).toBe('139d')
    expect(formatHomeAgentTime(DAY, translate)).toBe('1d')
  })

  it('shows whole hours under a day', () => {
    expect(formatHomeAgentTime(7 * HOUR + 59 * MINUTE, translate)).toBe('7h')
    expect(formatHomeAgentTime(DAY - 1, translate)).toBe('23h')
  })

  it('shows minutes under an hour', () => {
    expect(formatHomeAgentTime(42 * MINUTE + 59_000, translate)).toBe('42m')
    expect(formatHomeAgentTime(0, translate)).toBe('0m')
  })
})
