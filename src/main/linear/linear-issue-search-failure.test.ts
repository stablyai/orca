import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'

const rawRequest = vi.fn()
const getClients = vi.fn()
const clearToken = vi.fn()
const isAuthError = vi.fn()

vi.mock('./linear-request-concurrency', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn()
}))

vi.mock('./linear-token-store', () => ({
  clearToken: (...args: unknown[]) => clearToken(...args)
}))

vi.mock('./client', () => ({
  getClients: (...args: unknown[]) => getClients(...args),
  isAuthError: (...args: unknown[]) => isAuthError(...args)
}))

function makeEntry(options?: {
  workspaceId?: string
  organizationName?: string
  request?: typeof rawRequest
}): LinearClientForWorkspace {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the real search loader uses workspace metadata and rawRequest only; the SDK client fixture intentionally omits unrelated methods.
  return {
    workspace: {
      id: options?.workspaceId ?? 'workspace-1',
      organizationId: options?.workspaceId ?? 'workspace-1',
      organizationName: options?.organizationName ?? 'Workspace',
      displayName: 'Ada',
      email: 'ada@example.com'
    },
    client: {
      client: { rawRequest: options?.request ?? rawRequest }
    }
    // SAFETY: the search path uses only workspace metadata and the mocked rawRequest client.
  } as unknown as LinearClientForWorkspace
}

function rawIssue(id: string) {
  return {
    id,
    identifier: id,
    title: id,
    updatedAt: '2026-01-01T00:00:00.000Z',
    state: { name: 'Todo', type: 'unstarted', color: '#888888' },
    team: { id: 'team-1', name: 'Team', key: 'TM' },
    labels: { nodes: [] }
  }
}

describe('Linear search failures', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isAuthError.mockReturnValue(false)
    getClients.mockReturnValue([makeEntry()])
  })

  it('rejects failed provider search and preserves successful workspaces in an all-workspace search', async () => {
    const { searchIssues } = await import('./linear-issue-lookups')
    rawRequest.mockRejectedValueOnce(new Error('provider network failure'))
    await expect(searchIssues('bug', 36, 'workspace-1')).rejects.toThrow(
      'Unable to load Linear issues. Try again.'
    )
    const other = vi
      .fn()
      .mockResolvedValue({ data: { searchIssues: { nodes: [rawIssue('FRESH')] } } })
    getClients.mockReturnValue([
      makeEntry(),
      makeEntry({ workspaceId: 'workspace-2', request: other })
    ])
    rawRequest.mockRejectedValueOnce(new Error('one workspace unavailable'))
    await expect(searchIssues('bug', 36, 'all')).resolves.toMatchObject([{ id: 'FRESH' }])
    rawRequest.mockRejectedValueOnce(new Error('all unavailable'))
    other.mockRejectedValueOnce(new Error('all unavailable'))
    await expect(searchIssues('bug', 36, 'all')).rejects.toThrow(
      'Unable to load Linear issues. Try again.'
    )
  })
})
