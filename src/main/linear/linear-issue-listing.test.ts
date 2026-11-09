import { beforeEach, expect, it, vi } from 'vitest'
import { listIssues } from './linear-issue-listing'

const { getClients, rawRequest } = vi.hoisted(() => ({
  getClients: vi.fn(),
  rawRequest: vi.fn()
}))

vi.mock('./client', () => ({ getClients, isAuthError: () => false }))
vi.mock('./linear-token-store', () => ({ clearToken: vi.fn() }))
vi.mock('./linear-request-concurrency', () => ({ acquire: vi.fn(), release: vi.fn() }))

const issue = {
  id: 'issue-1',
  identifier: 'ENG-1',
  title: 'Task',
  url: 'https://linear.app/acme/issue/ENG-1/task',
  priority: 0,
  updatedAt: '2026-11-09T00:00:00.000Z',
  state: { name: 'In Progress', type: 'started', color: '#f2c94c' },
  team: { id: 'team-1', name: 'Engineering', key: 'ENG' },
  project: { id: 'project-1', name: 'Hardware verification', url: null, color: '#f7c8c1' }
}

beforeEach(() => {
  vi.clearAllMocks()
  getClients.mockReturnValue([
    {
      workspace: { id: 'workspace-1', organizationName: 'Workspace' },
      client: { client: { rawRequest } }
    }
  ])
  rawRequest.mockResolvedValue({
    data: { issues: { nodes: [issue], pageInfo: { hasNextPage: false } } }
  })
})

it('requests and preserves the project on open issue rows', async () => {
  const result = await listIssues('open', 20, 'workspace-1')

  expect(result.items).toHaveLength(1)
  expect(result.items[0].project).toStrictEqual({
    id: 'project-1',
    name: 'Hardware verification',
    url: undefined,
    color: '#f7c8c1'
  })
  expect(rawRequest.mock.calls[0][0]).toMatch(/project \{\s*id\s+name\s+url\s+color\s*\}/)
})
