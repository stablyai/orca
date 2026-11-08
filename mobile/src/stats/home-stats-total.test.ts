import { describe, expect, it } from 'vitest'
import { totalHomeStats } from './home-stats-total'

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
