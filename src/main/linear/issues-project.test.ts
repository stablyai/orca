import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'

const rawRequest = vi.fn()
const getClients = vi.fn()

vi.mock('./client', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn(),
  getClients: (...args: unknown[]) => getClients(...args),
  isAuthError: vi.fn().mockReturnValue(false),
  clearToken: vi.fn()
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
    client: { client: { rawRequest } }
  } as unknown as LinearClientForWorkspace
}

function rawIssue(id: string, project: { id: string; name: string; color?: string | null } | null) {
  return {
    id,
    identifier: id,
    title: id,
    description: 'Description',
    url: `https://linear.app/${id}`,
    estimate: 3,
    priority: 2,
    updatedAt: '2026-01-01T00:00:00.000Z',
    labelIds: [],
    project,
    state: { name: 'Todo', type: 'unstarted', color: '#888888' },
    team: { id: 'team-1', name: 'Team', key: 'TM' },
    labels: { nodes: [] }
  }
}

describe('Linear issue collection projects', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    getClients.mockReturnValue([makeEntry()])
  })

  it('selects and maps optional projects for issue lists', async () => {
    rawRequest.mockResolvedValueOnce({
      data: {
        issues: {
          nodes: [
            rawIssue('LIN-1', { id: 'project-1', name: 'Orca', color: '#5e6ad2' }),
            rawIssue('LIN-2', null)
          ]
        }
      }
    })
    const { listIssues } = await import('./issues')

    await expect(listIssues('all', 10, 'workspace-1')).resolves.toMatchObject({
      items: [
        { id: 'LIN-1', project: { id: 'project-1', name: 'Orca', color: '#5e6ad2' } },
        { id: 'LIN-2', project: undefined }
      ]
    })
    expect(rawRequest.mock.calls[0][0]).toContain('project {')
    expect(rawRequest.mock.calls[0][0]).toContain('color')
  })

  it('maps project summaries for issue search results', async () => {
    rawRequest.mockResolvedValueOnce({
      data: {
        searchIssues: {
          nodes: [rawIssue('LIN-1', { id: 'project-1', name: 'Orca', color: null })]
        }
      }
    })
    const { searchIssues } = await import('./issues')

    await expect(searchIssues('Orca', 10, 'workspace-1')).resolves.toMatchObject([
      { project: { id: 'project-1', name: 'Orca', color: undefined } }
    ])
  })
})
