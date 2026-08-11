import { describe, expect, it } from 'vitest'
import { totalHomeStats, type HomeStatsSummary } from './home-stats-total'

function stats(overrides: Partial<HomeStatsSummary> = {}): HomeStatsSummary {
  return {
    totalAgentsSpawned: 10,
    totalPRsCreated: 2,
    totalAgentTimeMs: 60_000,
    firstEventAt: 1_700_000_000_000,
    ...overrides
  }
}

describe('totalHomeStats', () => {
  it('has nothing to show before any host answers', () => {
    expect(totalHomeStats({}, ['host-1'])).toBeNull()
  })

  it('passes a single host through unchanged', () => {
    expect(totalHomeStats({ 'host-1': stats() }, ['host-1'])).toEqual(stats())
  })

  it('sums every desktop instead of letting the last reply win', () => {
    const total = totalHomeStats(
      {
        'host-1': stats(),
        'host-2': stats({ totalAgentsSpawned: 5, totalPRsCreated: 1, totalAgentTimeMs: 30_000 })
      },
      ['host-1', 'host-2']
    )

    expect(total).toMatchObject({
      totalAgentsSpawned: 15,
      totalPRsCreated: 3,
      totalAgentTimeMs: 90_000
    })
  })

  it('drops a removed desktop from the total', () => {
    // Replies are cached for the life of the process, so the entry outlives the pairing.
    const byHost = {
      'host-1': stats(),
      'host-2': stats({ totalAgentsSpawned: 5, totalPRsCreated: 1, totalAgentTimeMs: 30_000 })
    }

    expect(totalHomeStats(byHost, ['host-1'])).toEqual(stats())
    expect(totalHomeStats(byHost, [])).toBeNull()
  })

  it('keeps the earliest known first event', () => {
    const total = totalHomeStats(
      {
        'host-1': stats({ firstEventAt: 2_000 }),
        'host-2': stats({ firstEventAt: null }),
        'host-3': stats({ firstEventAt: 1_000 })
      },
      ['host-1', 'host-2', 'host-3']
    )

    expect(total?.firstEventAt).toBe(1_000)
  })

  it('reports no first event when no host has one', () => {
    expect(
      totalHomeStats({ 'host-1': stats({ firstEventAt: null }) }, ['host-1'])?.firstEventAt
    ).toBeNull()
  })

  it('ignores a malformed reply instead of poisoning the header', () => {
    const total = totalHomeStats(
      {
        'host-1': stats(),
        'host-2': null as unknown as HomeStatsSummary,
        'host-3': { totalAgentsSpawned: 'lots' } as unknown as HomeStatsSummary
      },
      ['host-1', 'host-2', 'host-3']
    )

    expect(total).toEqual(stats())
  })
})
