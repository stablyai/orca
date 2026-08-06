import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'
import type { LinearWorkspace } from '../../shared/types'

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
  clearToken: (...args: unknown[]) => clearToken(...args),
  // The signed public-file-url client reuses the same underlying raw client, so
  // body reads route through the entry's rawRequest spy in these tests.
  getPublicFileUrlClient: (entry: LinearClientForWorkspace) => entry.client
}))

function workspace(id: string, organizationUrlKey: string): LinearWorkspace {
  return {
    id,
    organizationId: id,
    organizationName: organizationUrlKey,
    organizationUrlKey,
    displayName: 'Ada',
    email: 'ada@example.com'
  }
}

function makeEntry(options: {
  workspace: LinearWorkspace
  rawRequest: ReturnType<typeof vi.fn>
}): LinearClientForWorkspace {
  return {
    workspace: options.workspace,
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
    url: `https://linear.app/stably/issue/${identifier}`,
    labels: { nodes: [] }
  }
}

describe('Linear issue context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getStatus.mockReturnValue({ workspaces: [] })
    isAuthError.mockReturnValue(false)
  })

  it('resolves --current worktree links written as split Linear CLI metadata', async () => {
    const stably = workspace('workspace-stably', 'stably')
    const rawRequest = vi.fn().mockResolvedValue({ data: { issue: rawIssue('STA-335') } })
    getStatus.mockReturnValue({ workspaces: [stably] })
    getClients.mockReturnValue([makeEntry({ workspace: stably, rawRequest })])
    const { readLinearIssueContext } = await import('./issue-context')

    await expect(
      readLinearIssueContext(
        {
          current: true,
          include: {
            attachments: false,
            children: false,
            comments: false,
            relations: false,
            activity: false
          },
          depth: 0
        },
        async () => ({
          identifier: 'STA-335',
          workspaceId: null,
          organizationUrlKey: 'stably',
          worktreeId: 'repo::/tmp/repo/feature',
          worktreePath: '/tmp/repo/feature'
        })
      )
    ).resolves.toMatchObject({
      issue: { identifier: 'STA-335' },
      meta: {
        resolved: {
          workspaceId: 'workspace-stably',
          worktreeId: 'repo::/tmp/repo/feature',
          worktreePath: '/tmp/repo/feature'
        }
      }
    })
    expect(getClients).toHaveBeenCalledWith('workspace-stably')
  })
})
