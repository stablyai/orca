import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'

const getClients = vi.fn()
const getStatus = vi.fn()
const isAuthError = vi.fn()
const clearToken = vi.fn()

vi.mock('./client', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn(),
  getClients: (...args: unknown[]) => getClients(...args),
  getStatus: (...args: unknown[]) => getStatus(...args),
  isAuthError: (...args: unknown[]) => isAuthError(...args),
  clearToken: (...args: unknown[]) => clearToken(...args)
}))

function makeEntry(options: {
  workspaceId: string
  organizationName: string
  rawRequest: ReturnType<typeof vi.fn>
}): LinearClientForWorkspace {
  return {
    workspace: {
      id: options.workspaceId,
      organizationId: options.workspaceId,
      organizationName: options.organizationName,
      displayName: 'Brennan',
      email: 'brennan@example.com'
    },
    client: {
      client: { rawRequest: options.rawRequest }
    }
  } as unknown as LinearClientForWorkspace
}

function rawIssue(identifier: string) {
  return {
    id: `${identifier}-id`,
    identifier,
    title: `Title ${identifier}`,
    url: `https://linear.app/acme/issue/${identifier}`,
    labels: { nodes: [] }
  }
}

describe('Linear agent issue context client', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getStatus.mockReturnValue({ workspaces: [] })
    isAuthError.mockReturnValue(false)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('keeps implicit multi-workspace issue reads working when an unrelated workspace fails', async () => {
    const failingRequest = vi.fn().mockRejectedValue(new Error('fetch failed'))
    const workingRequest = vi.fn().mockResolvedValue({ data: { issue: rawIssue('ENG-123') } })
    getClients.mockReturnValue([
      makeEntry({
        workspaceId: 'workspace-stale',
        organizationName: 'Stale',
        rawRequest: failingRequest
      }),
      makeEntry({
        workspaceId: 'workspace-good',
        organizationName: 'Good',
        rawRequest: workingRequest
      })
    ])
    const { resolveIssue } = await import('./issue-context-client')

    await expect(resolveIssue('ENG-123', {})).resolves.toMatchObject({
      issue: { identifier: 'ENG-123' },
      workspace: { id: 'workspace-good' }
    })
    expect(console.warn).toHaveBeenCalledWith(
      '[linear] agent issue read failed:',
      expect.any(Error)
    )
  })

  it('keeps implicit multi-workspace search working when an unrelated workspace fails', async () => {
    const failingRequest = vi.fn().mockRejectedValue(new Error('fetch failed'))
    const workingRequest = vi.fn().mockResolvedValue({
      data: { searchIssues: { nodes: [rawIssue('ENG-123')] } }
    })
    getClients.mockReturnValue([
      makeEntry({
        workspaceId: 'workspace-stale',
        organizationName: 'Stale',
        rawRequest: failingRequest
      }),
      makeEntry({
        workspaceId: 'workspace-good',
        organizationName: 'Good',
        rawRequest: workingRequest
      })
    ])
    const { searchLinearIssuesForAgents } = await import('./issue-context-client')

    await expect(
      searchLinearIssuesForAgents({ query: 'auth', workspaceId: 'all' })
    ).resolves.toMatchObject({
      issues: [{ identifier: 'ENG-123', workspace: { id: 'workspace-good' } }],
      meta: {
        returned: 1,
        partial: true,
        workspaceErrors: [
          {
            workspace: { id: 'workspace-stale', name: 'Stale' },
            code: 'linear_network_error'
          }
        ]
      }
    })
  })

  it('keeps all-workspace search working when one saved credential cannot load', async () => {
    const workingRequest = vi.fn().mockResolvedValue({
      data: { searchIssues: { nodes: [rawIssue('ENG-123')] } }
    })
    getStatus.mockReturnValue({
      workspaces: [
        {
          id: 'workspace-stale',
          organizationId: 'workspace-stale',
          organizationName: 'Stale',
          displayName: 'Brennan',
          email: 'brennan@example.com'
        },
        {
          id: 'workspace-good',
          organizationId: 'workspace-good',
          organizationName: 'Good',
          displayName: 'Brennan',
          email: 'brennan@example.com'
        }
      ]
    })
    getClients.mockImplementation((workspaceId: string) => {
      if (workspaceId === 'workspace-stale') {
        throw new Error('Could not decrypt Linear credential')
      }
      return [
        makeEntry({
          workspaceId: 'workspace-good',
          organizationName: 'Good',
          rawRequest: workingRequest
        })
      ]
    })
    const { searchLinearIssuesForAgents } = await import('./issue-context-client')

    await expect(
      searchLinearIssuesForAgents({ query: 'auth', workspaceId: 'all' })
    ).resolves.toMatchObject({
      issues: [{ identifier: 'ENG-123', workspace: { id: 'workspace-good' } }],
      meta: {
        returned: 1,
        partial: true,
        workspaceErrors: [
          {
            workspace: { id: 'workspace-stale', name: 'Stale' },
            message: 'Could not decrypt Linear credential'
          }
        ]
      }
    })
  })

  it('does not report not-found when every successful workspace missed but another failed', async () => {
    const failingRequest = vi.fn().mockRejectedValue(new Error('fetch failed'))
    const missingRequest = vi.fn().mockResolvedValue({ data: { issue: null } })
    getClients.mockReturnValue([
      makeEntry({
        workspaceId: 'workspace-stale',
        organizationName: 'Stale',
        rawRequest: failingRequest
      }),
      makeEntry({
        workspaceId: 'workspace-empty',
        organizationName: 'Empty',
        rawRequest: missingRequest
      })
    ])
    const { resolveIssue } = await import('./issue-context-client')

    await expect(resolveIssue('ENG-123', {})).rejects.toMatchObject({
      code: 'linear_network_error'
    })
  })

  it('preserves hard errors for explicitly selected workspaces', async () => {
    const failingRequest = vi.fn().mockRejectedValue(new Error('fetch failed'))
    getStatus.mockReturnValue({
      workspaces: [
        {
          id: 'workspace-selected',
          organizationId: 'workspace-selected',
          organizationName: 'Selected',
          displayName: 'Brennan',
          email: 'brennan@example.com'
        }
      ]
    })
    getClients.mockReturnValue([
      makeEntry({
        workspaceId: 'workspace-selected',
        organizationName: 'Selected',
        rawRequest: failingRequest
      })
    ])
    const { resolveIssue } = await import('./issue-context-client')

    await expect(
      resolveIssue('ENG-123', { workspaceId: 'workspace-selected' })
    ).rejects.toMatchObject({ code: 'linear_network_error' })
  })

  it('normalizes explicit issue workspace credential-load failures', async () => {
    getStatus.mockReturnValue({
      workspaces: [
        {
          id: 'workspace-selected',
          organizationId: 'workspace-selected',
          organizationName: 'Selected',
          displayName: 'Brennan',
          email: 'brennan@example.com'
        }
      ]
    })
    getClients.mockImplementation((workspaceId: string) => {
      if (workspaceId === 'workspace-selected') {
        throw new Error('Could not decrypt Linear credential')
      }
      return []
    })
    const { resolveIssue } = await import('./issue-context-client')

    await expect(
      resolveIssue('ENG-123', { workspaceId: 'workspace-selected' })
    ).rejects.toMatchObject({
      code: 'linear_network_error',
      message: 'Could not decrypt Linear credential'
    })
  })

  it('normalizes explicit search workspace credential-load failures', async () => {
    getStatus.mockReturnValue({
      workspaces: [
        {
          id: 'workspace-selected',
          organizationId: 'workspace-selected',
          organizationName: 'Selected',
          displayName: 'Brennan',
          email: 'brennan@example.com'
        }
      ]
    })
    getClients.mockImplementation((workspaceId: string) => {
      if (workspaceId === 'workspace-selected') {
        throw new Error('Could not decrypt Linear credential')
      }
      return []
    })
    const { searchLinearIssuesForAgents } = await import('./issue-context-client')

    await expect(
      searchLinearIssuesForAgents({ query: 'auth', workspaceId: 'workspace-selected' })
    ).rejects.toMatchObject({
      code: 'linear_network_error',
      message: 'Could not decrypt Linear credential'
    })
  })

  it('reports an invalid workspace for explicit search workspace typos', async () => {
    getStatus.mockReturnValue({
      workspaces: [
        {
          id: 'workspace-selected',
          organizationId: 'workspace-selected',
          organizationName: 'Selected',
          displayName: 'Brennan',
          email: 'brennan@example.com'
        }
      ]
    })
    const { searchLinearIssuesForAgents } = await import('./issue-context-client')

    await expect(
      searchLinearIssuesForAgents({ query: 'auth', workspaceId: 'workspace-typo' })
    ).rejects.toMatchObject({
      code: 'linear_invalid_workspace'
    })
    expect(getClients).not.toHaveBeenCalled()
  })

  it('reports invalid explicit search workspace typos when clients still exist', async () => {
    const workingRequest = vi.fn()
    getStatus.mockReturnValue({ connected: false, workspaces: [] })
    getClients.mockImplementation((workspaceId: string) => {
      if (workspaceId === 'all') {
        return [
          makeEntry({
            workspaceId: 'workspace-good',
            organizationName: 'Good',
            rawRequest: workingRequest
          })
        ]
      }
      return []
    })
    const { searchLinearIssuesForAgents } = await import('./issue-context-client')

    await expect(
      searchLinearIssuesForAgents({ query: 'auth', workspaceId: 'workspace-typo' })
    ).rejects.toMatchObject({
      code: 'linear_invalid_workspace'
    })
    expect(workingRequest).not.toHaveBeenCalled()
  })

  it('does not fan out explicit issue workspace typos when clients still exist', async () => {
    const workingRequest = vi.fn().mockResolvedValue({ data: { issue: rawIssue('ENG-123') } })
    getStatus.mockReturnValue({ connected: false, workspaces: [] })
    getClients.mockImplementation((workspaceId: string) => {
      if (workspaceId === 'all') {
        return [
          makeEntry({
            workspaceId: 'workspace-good',
            organizationName: 'Good',
            rawRequest: workingRequest
          })
        ]
      }
      return []
    })
    const { resolveIssue } = await import('./issue-context-client')

    await expect(resolveIssue('ENG-123', { workspaceId: 'workspace-typo' })).rejects.toMatchObject({
      code: 'linear_invalid_workspace'
    })
    expect(workingRequest).not.toHaveBeenCalled()
  })
})
