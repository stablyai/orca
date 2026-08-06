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

function entry(): LinearClientForWorkspace {
  return {
    workspace: {
      id: 'workspace-1',
      organizationId: 'workspace-1',
      organizationName: 'Acme',
      displayName: 'Ada',
      email: 'ada@example.com'
    },
    client: { client: { rawRequest } }
  } as unknown as LinearClientForWorkspace
}

const issue = {
  id: 'issue-1',
  identifier: 'ENG-1',
  title: 'Current',
  url: 'https://linear.app/acme/issue/ENG-1'
}
const relatedIssue = {
  id: 'issue-2',
  identifier: 'ENG-2',
  title: 'Related',
  url: 'https://linear.app/acme/issue/ENG-2'
}

function connection(field: 'relations' | 'inverseRelations', nodes: unknown[]) {
  return {
    data: { issue: { [field]: { nodes, pageInfo: { hasNextPage: false } } } }
  }
}

describe('Linear issue relation writes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getClients.mockReturnValue([entry()])
  })

  it('swaps relation endpoints when adding blocked-by', async () => {
    rawRequest.mockResolvedValueOnce(connection('inverseRelations', [])).mockResolvedValueOnce({
      data: {
        issueRelationCreate: {
          success: true,
          issueRelation: {
            id: 'relation-1',
            type: 'blocks',
            issue: relatedIssue,
            relatedIssue: issue
          }
        }
      }
    })
    const { writeIssueRelation } = await import('./issue-relation-write')

    const result = await writeIssueRelation({
      issue,
      relatedIssue,
      relationship: 'blockedBy',
      operation: 'add',
      workspaceId: 'workspace-1'
    })

    expect(rawRequest.mock.calls[1]?.[1]).toEqual({
      input: { issueId: 'issue-2', relatedIssueId: 'issue-1', type: 'blocks' }
    })
    expect(rawRequest).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      operation: 'add',
      relation: { direction: 'inbound', relationship: 'blockedBy' },
      meta: { alreadySet: false }
    })
  })

  it('does not create an equivalent relation twice', async () => {
    rawRequest.mockResolvedValueOnce(
      connection('relations', [{ id: 'relation-1', type: 'related', relatedIssue }])
    )
    const { writeIssueRelation } = await import('./issue-relation-write')

    const result = await writeIssueRelation({
      issue,
      relatedIssue,
      relationship: 'relatedTo',
      operation: 'add',
      workspaceId: 'workspace-1'
    })

    expect(rawRequest).toHaveBeenCalledTimes(1)
    expect(result.meta.alreadySet).toBe(true)
  })

  it('finds and removes inverse relations', async () => {
    rawRequest
      .mockResolvedValueOnce(
        connection('inverseRelations', [{ id: 'relation-1', type: 'blocks', issue: relatedIssue }])
      )
      .mockResolvedValueOnce({ data: { issueRelationDelete: { success: true } } })
    const { writeIssueRelation } = await import('./issue-relation-write')

    const result = await writeIssueRelation({
      issue,
      relatedIssue,
      relationship: 'blockedBy',
      operation: 'remove',
      workspaceId: 'workspace-1'
    })

    expect(rawRequest.mock.calls[1]?.[1]).toEqual({ id: 'relation-1' })
    expect(rawRequest).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      operation: 'remove',
      relation: { direction: 'inbound', relationship: 'blockedBy' },
      meta: { alreadySet: false }
    })
  })

  it('checks both directions before adding a symmetric related relation', async () => {
    rawRequest
      .mockResolvedValueOnce(connection('relations', []))
      .mockResolvedValueOnce(
        connection('inverseRelations', [{ id: 'relation-1', type: 'related', issue: relatedIssue }])
      )
    const { writeIssueRelation } = await import('./issue-relation-write')

    const result = await writeIssueRelation({
      issue,
      relatedIssue,
      relationship: 'relatedTo',
      operation: 'add',
      workspaceId: 'workspace-1'
    })

    expect(rawRequest).toHaveBeenCalledTimes(2)
    expect(result.meta.alreadySet).toBe(true)
    expect(result.relation).toMatchObject({ direction: 'inbound', relationship: 'relatedTo' })
  })

  it('refuses a write when the idempotency scan reaches its cap', async () => {
    for (let page = 0; page < 5; page += 1) {
      rawRequest.mockResolvedValueOnce({
        data: {
          issue: {
            relations: {
              nodes: Array.from({ length: 50 }, (_, index) => ({
                id: `relation-${page}-${index}`,
                type: 'blocks',
                relatedIssue: { ...relatedIssue, id: `other-${page}-${index}` }
              })),
              pageInfo: { hasNextPage: true, endCursor: `cursor-${page}` }
            }
          }
        }
      })
    }
    const { writeIssueRelation } = await import('./issue-relation-write')

    await expect(
      writeIssueRelation({
        issue,
        relatedIssue,
        relationship: 'blocks',
        operation: 'add',
        workspaceId: 'workspace-1'
      })
    ).rejects.toMatchObject({ code: 'linear_write_failed' })

    expect(rawRequest).toHaveBeenCalledTimes(5)
  })

  it('marks an ambiguous create transport failure as unconfirmed', async () => {
    rawRequest
      .mockResolvedValueOnce(connection('relations', []))
      .mockRejectedValueOnce(new Error('fetch failed: socket hang up'))
    const { writeIssueRelation } = await import('./issue-relation-write')

    await expect(
      writeIssueRelation({
        issue,
        relatedIssue,
        relationship: 'blocks',
        operation: 'add',
        workspaceId: 'workspace-1'
      })
    ).rejects.toMatchObject({ kind: 'unconfirmed' })

    expect(rawRequest).toHaveBeenCalledTimes(2)
  })

  it('keeps safe pre-connect mutation failures retryable as network errors', async () => {
    rawRequest
      .mockResolvedValueOnce(connection('relations', []))
      .mockRejectedValueOnce(new Error('connect ENOTFOUND api.linear.app'))
    const { writeIssueRelation } = await import('./issue-relation-write')

    await expect(
      writeIssueRelation({
        issue,
        relatedIssue,
        relationship: 'blocks',
        operation: 'add',
        workspaceId: 'workspace-1'
      })
    ).rejects.toMatchObject({ kind: 'network' })

    expect(rawRequest).toHaveBeenCalledTimes(2)
  })
})
