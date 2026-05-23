import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'

const rawRequest = vi.fn()
const getClients = vi.fn()
const clearToken = vi.fn()

vi.mock('./client', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn(),
  getClients: (...args: unknown[]) => getClients(...args),
  isAuthError: vi.fn().mockReturnValue(false),
  clearToken: (...args: unknown[]) => clearToken(...args)
}))

function makeEntry(): LinearClientForWorkspace {
  return {
    workspace: {
      id: 'workspace-1',
      organizationId: 'workspace-1',
      organizationName: 'Workspace',
      displayName: 'Ada',
      email: 'ada@example.com'
    },
    client: {
      client: { rawRequest }
    }
  } as unknown as LinearClientForWorkspace
}

function rawIssue(id: string, updatedAt = '2026-01-01T00:00:00.000Z') {
  return {
    id,
    identifier: id,
    title: id,
    description: 'Description',
    url: `https://linear.app/${id}`,
    estimate: 3,
    priority: 2,
    updatedAt,
    labelIds: ['label-1'],
    state: { name: 'Todo', type: 'unstarted', color: '#888888' },
    team: { id: 'team-1', name: 'Team', key: 'TM' },
    assignee: { id: 'user-1', displayName: 'Ada', avatarUrl: null },
    labels: { nodes: [{ id: 'label-1', name: 'Bug' }] }
  }
}

describe('Linear issue queries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getClients.mockReturnValue([makeEntry()])
  })

  it('lists issues with one raw GraphQL request and maps row fields', async () => {
    rawRequest.mockResolvedValueOnce({
      data: { issues: { nodes: [rawIssue('LIN-1')] } }
    })
    const { listIssues } = await import('./issues')

    await expect(listIssues('all', 36, 'workspace-1')).resolves.toMatchObject([
      {
        id: 'LIN-1',
        labels: ['Bug'],
        labelIds: ['label-1'],
        workspaceId: 'workspace-1',
        team: { id: 'team-1' },
        estimate: 3
      }
    ])

    expect(rawRequest).toHaveBeenCalledTimes(1)
    expect(rawRequest.mock.calls[0][0]).toContain('query OrcaLinearIssues')
    expect(rawRequest.mock.calls[0][0]).toContain('estimate')
  })

  it('keeps single-workspace search results in Linear relevance order', async () => {
    rawRequest.mockResolvedValueOnce({
      data: {
        searchIssues: {
          nodes: [
            rawIssue('LIN-OLD', '2026-01-01T00:00:00.000Z'),
            rawIssue('LIN-NEW', '2026-02-01T00:00:00.000Z')
          ]
        }
      }
    })
    const { searchIssues } = await import('./issues')

    await expect(searchIssues('bug', 36, 'workspace-1')).resolves.toMatchObject([
      { id: 'LIN-OLD' },
      { id: 'LIN-NEW' }
    ])

    expect(rawRequest).toHaveBeenCalledTimes(1)
    expect(rawRequest.mock.calls[0][0]).toContain('query OrcaLinearIssueSearch')
    expect(rawRequest.mock.calls[0][0]).toContain('searchIssues(term: $term')
    expect(rawRequest.mock.calls[0][1]).toEqual({ term: 'bug', first: 36 })
  })

  it('uses raw labelIds as the complete mutation-safe label set', async () => {
    rawRequest.mockResolvedValueOnce({
      data: {
        issues: {
          nodes: [
            {
              ...rawIssue('LIN-1'),
              labelIds: ['label-1', 'label-2'],
              labels: { nodes: [{ id: 'label-1', name: 'Bug' }] }
            }
          ]
        }
      }
    })
    const { listIssues } = await import('./issues')

    await expect(listIssues('all', 36, 'workspace-1')).resolves.toMatchObject([
      {
        id: 'LIN-1',
        labels: ['Bug'],
        labelIds: ['label-1', 'label-2']
      }
    ])
  })

  it('sends estimate updates through to Linear', async () => {
    const updateIssue = vi.fn().mockResolvedValue({ success: true })
    getClients.mockReturnValue([
      {
        ...makeEntry(),
        client: {
          updateIssue
        }
      }
    ])
    const { updateIssue: updateLinearIssue } = await import('./issues')

    await expect(updateLinearIssue('issue-1', { estimate: 5 }, 'workspace-1')).resolves.toEqual({
      ok: true
    })

    expect(updateIssue).toHaveBeenCalledWith('issue-1', { estimate: 5 })
  })
})
