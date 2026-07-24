import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'
import { MAX_INTEGRATION_ACCOUNTS } from '../integration-account-persistence-limits'
import { LINEAR_SEARCH_MAX_LIMIT } from '../../shared/linear-agent-access'

const getClients = vi.fn()

vi.mock('./client', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn(),
  getClients: (...args: unknown[]) => getClients(...args),
  isAuthError: vi.fn().mockReturnValue(false),
  clearToken: vi.fn()
}))

function issue(id: string) {
  return {
    id,
    identifier: id,
    title: id,
    description: '',
    url: `https://linear.app/${id}`,
    estimate: null,
    priority: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
    labelIds: [],
    labels: { nodes: [] }
  }
}

function entry(id: string, rawRequest: ReturnType<typeof vi.fn>): LinearClientForWorkspace {
  return {
    workspace: {
      id,
      organizationId: id,
      organizationName: id,
      displayName: 'Ada',
      email: null
    },
    client: { client: { rawRequest } }
  } as unknown as LinearClientForWorkspace
}

describe('Linear issue retention bounds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('retains only the requested list page when a provider returns extra rows', async () => {
    const rawRequest = vi.fn().mockResolvedValue({
      data: {
        issues: {
          nodes: [issue('LIN-1'), issue('LIN-2')],
          pageInfo: { hasNextPage: false }
        }
      }
    })
    getClients.mockReturnValue([entry('workspace-1', rawRequest)])
    const { listIssues } = await import('./issues')

    await expect(listIssues('all', 1, 'workspace-1')).resolves.toMatchObject({
      items: [{ id: 'LIN-1' }],
      hasMore: true
    })
    expect(rawRequest.mock.calls[0]?.[1]).toMatchObject({ first: 1 })
  })

  it('clamps direct search callers and maps no more than the requested rows', async () => {
    const rawRequest = vi.fn().mockResolvedValue({
      data: {
        searchIssues: {
          nodes: Array.from({ length: LINEAR_SEARCH_MAX_LIMIT + 1 }, (_, index) =>
            issue(`LIN-${index + 1}`)
          )
        }
      }
    })
    getClients.mockReturnValue([entry('workspace-1', rawRequest)])
    const { searchIssues } = await import('./issues')

    await expect(searchIssues('bug', Number.MAX_SAFE_INTEGER, 'workspace-1')).resolves.toHaveLength(
      LINEAR_SEARCH_MAX_LIMIT
    )
    expect(rawRequest.mock.calls[0]?.[1]).toMatchObject({ first: LINEAR_SEARCH_MAX_LIMIT })
  })

  it('stops all-workspace scheduling at the aggregate account boundary', async () => {
    const requests = Array.from({ length: MAX_INTEGRATION_ACCOUNTS + 1 }, (_, index) =>
      vi.fn().mockResolvedValue({
        data: {
          issues: {
            nodes: [issue(`LIN-${index + 1}`)],
            pageInfo: { hasNextPage: false }
          }
        }
      })
    )
    getClients.mockReturnValue(
      requests.map((request, index) => entry(`workspace-${index}`, request))
    )
    const { listIssues } = await import('./issues')

    await expect(listIssues('all', 1, 'all')).resolves.toMatchObject({
      items: [{ id: 'LIN-1' }],
      hasMore: true
    })
    expect(requests[MAX_INTEGRATION_ACCOUNTS - 1]).toHaveBeenCalledTimes(1)
    expect(requests[MAX_INTEGRATION_ACCOUNTS]).not.toHaveBeenCalled()
  })
})
