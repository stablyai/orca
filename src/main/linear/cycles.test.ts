import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'

const rawRequest = vi.fn()

vi.mock('./linear-request-concurrency', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn()
}))

vi.mock('./linear-token-store', () => ({ clearToken: vi.fn() }))
vi.mock('./client', () => ({ isAuthError: () => false }))

const entry = {
  workspace: { id: 'workspace-1', organizationName: 'Acme' },
  client: { client: { rawRequest } }
} as unknown as LinearClientForWorkspace

function cycle(id: string, number: number, isActive = false) {
  return {
    id,
    number,
    name: `Cycle ${number}`,
    description: null,
    startsAt: '2026-08-01T00:00:00.000Z',
    endsAt: '2026-08-14T00:00:00.000Z',
    isActive,
    isFuture: !isActive,
    isPast: false
  }
}

describe('Linear cycle discovery', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reads every cycle page and returns deterministic cycle-number order', async () => {
    rawRequest
      .mockResolvedValueOnce({
        data: {
          team: {
            cycles: {
              nodes: [cycle('cycle-2', 2)],
              pageInfo: { hasNextPage: true, endCursor: 'page-2' }
            }
          }
        }
      })
      .mockResolvedValueOnce({
        data: {
          team: {
            cycles: {
              nodes: [cycle('cycle-1', 1)],
              pageInfo: { hasNextPage: false }
            }
          }
        }
      })
    const { listTeamCyclesForAgent } = await import('./cycles')

    const result = await listTeamCyclesForAgent(entry, 'team-1', false)

    expect(result.map(({ id }) => id)).toEqual(['cycle-1', 'cycle-2'])
    expect(rawRequest.mock.calls[0]?.[1]).toMatchObject({ teamId: 'team-1', first: 50 })
    expect(rawRequest.mock.calls[0]?.[1]).not.toHaveProperty('filter')
    expect(rawRequest.mock.calls[1]?.[1]).toMatchObject({ after: 'page-2' })
  })

  it('asks Linear for only the current cycle', async () => {
    rawRequest.mockResolvedValueOnce({
      data: {
        team: {
          cycles: { nodes: [cycle('cycle-current', 7, true)], pageInfo: { hasNextPage: false } }
        }
      }
    })
    const { listTeamCyclesForAgent } = await import('./cycles')

    const result = await listTeamCyclesForAgent(entry, 'team-1', true)

    expect(result).toMatchObject([{ id: 'cycle-current', isActive: true }])
    expect(rawRequest.mock.calls[0]?.[1]).toMatchObject({ filter: { isActive: { eq: true } } })
  })

  it('matches current cycles and exact IDs or names deterministically', async () => {
    const { matchTeamCycles } = await import('./cycles')
    const cycles = [cycle('cycle-current', 7, true), cycle('cycle-future', 8)]

    expect(matchTeamCycles(cycles, 'current').map(({ id }) => id)).toEqual(['cycle-current'])
    expect(matchTeamCycles(cycles, 'CYCLE-FUTURE').map(({ id }) => id)).toEqual(['cycle-future'])
    expect(matchTeamCycles(cycles, 'cycle 8').map(({ id }) => id)).toEqual(['cycle-future'])
    expect(matchTeamCycles(cycles, 'Cycle')).toEqual([])
  })
})
