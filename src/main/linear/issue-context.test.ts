import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from './client'
import type { LinearWorkspace } from '../../shared/linear/workspace-types'

const getClients = vi.fn()
const getStatus = vi.fn()
const isAuthError = vi.fn()
const clearToken = vi.fn()

vi.mock('./linear-request-concurrency', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn()
}))

vi.mock('./linear-token-store', () => ({
  clearToken: (...args: unknown[]) => clearToken(...args)
}))

vi.mock('./client', () => ({
  getClients: (...args: unknown[]) => getClients(...args),
  getStatus: (...args: unknown[]) => getStatus(...args),
  isAuthError: (...args: unknown[]) => isAuthError(...args),
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

  it.each([
    {
      id: 'parent-id',
      identifier: 'ENG-1',
      title: 'Launch',
      url: 'https://linear.app/acme/issue/ENG-1'
    },
    null,
    undefined
  ])('preserves parent context in issue reads and searches (%j)', async (parent) => {
    const acme = workspace('workspace-acme', 'acme')
    const issue = { ...rawIssue('ENG-2'), parent }
    const rawRequest = vi
      .fn()
      .mockResolvedValueOnce({ data: { issue } })
      .mockResolvedValueOnce({ data: { searchIssues: { nodes: [issue] } } })
    getStatus.mockReturnValue({ workspaces: [acme] })
    getClients.mockReturnValue([makeEntry({ workspace: acme, rawRequest })])
    const { readLinearIssueContext, searchLinearIssuesForAgents } = await import('./issue-context')

    const read = await readLinearIssueContext(
      {
        input: 'ENG-2',
        workspaceId: acme.id,
        include: {
          attachments: false,
          children: false,
          comments: false,
          relations: false,
          activity: false
        },
        depth: 0
      },
      async () => {
        throw new Error('unused')
      }
    )
    const search = await searchLinearIssuesForAgents({ query: 'Launch', workspaceId: acme.id })

    expect(read.issue.parent).toEqual(parent)
    expect(search.issues[0]?.parent).toEqual(parent)
    expect(rawRequest).toHaveBeenCalledTimes(2)
    for (const [query] of rawRequest.mock.calls) {
      expect(query).toMatch(/parent\s*\{\s*id\s+identifier\s+title\s+url\s*\}/)
    }
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
