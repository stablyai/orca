import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LinearClientForWorkspace } from '../client'
import type { LinearWorkspace } from '../../../shared/linear/workspace-types'

const getClients = vi.fn()
const getStatus = vi.fn()
const isAuthError = vi.fn()
const clearToken = vi.fn()

vi.mock('../linear-request-concurrency', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn()
}))

vi.mock('../linear-token-store', () => ({
  clearToken: (...args: unknown[]) => clearToken(...args)
}))

vi.mock('../client', () => ({
  getClients: (...args: unknown[]) => getClients(...args),
  getStatus: (...args: unknown[]) => getStatus(...args),
  isAuthError: (...args: unknown[]) => isAuthError(...args),
  // Alias the signed client so body reads remain visible through the entry spy.
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
    const { readLinearIssueContext } = await import('./read-context')

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
    expect(getClients).toHaveBeenCalledWith('workspace-stably', undefined)
  })

  it('returns partial context and attachment metadata when the optional comment read fails', async () => {
    const selected = workspace('workspace-proof', 'proof')
    const rawRequest = vi
      .fn()
      .mockResolvedValueOnce({ data: { issue: rawIssue('ENG-1') } })
      .mockRejectedValueOnce(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('socket closed'), { code: 'ECONNRESET' })
        })
      )
      .mockResolvedValueOnce({
        data: {
          issue: {
            attachments: {
              nodes: [{ id: 'attachment-1', title: 'Plan', url: 'https://example.invalid/plan' }],
              pageInfo: { hasNextPage: false }
            }
          }
        }
      })
    getClients.mockReturnValue([makeEntry({ workspace: selected, rawRequest })])
    const { readLinearIssueContext } = await import('./read-context')

    const output = await readLinearIssueContext(
      {
        input: 'ENG-1',
        workspaceId: selected.id,
        include: {
          comments: true,
          children: false,
          attachments: true,
          relations: false,
          activity: false
        },
        depth: 0
      },
      async () => {
        throw new Error('Unexpected current issue lookup')
      }
    )

    expect(output).toMatchObject({
      issue: { identifier: 'ENG-1' },
      attachments: [{ id: 'attachment-1', title: 'Plan', metadataOnly: true }],
      meta: {
        partial: true,
        includeErrors: [
          { include: 'comments', code: 'linear_network_error', message: 'fetch failed' }
        ],
        sections: { attachments: { returned: 1, hasMore: false } }
      }
    })
    expect(output.comments).toBeUndefined()
    expect(rawRequest).toHaveBeenCalledTimes(3)
    expect(rawRequest.mock.calls[2]?.[1]).toEqual({ id: 'ENG-1-id', first: 50 })
  })
})
