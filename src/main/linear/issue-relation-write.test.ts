import { describe, expect, it, vi } from 'vitest'

const { rawRequest } = vi.hoisted(() => ({ rawRequest: vi.fn() }))

vi.mock('./linear-request-concurrency', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn()
}))

vi.mock('./linear-token-store', () => ({
  clearToken: vi.fn()
}))

vi.mock('./client', () => ({
  getClients: () => [{ workspace: { id: 'workspace-1' }, client: { client: { rawRequest } } }],
  isAuthError: () => false
}))

import { writeIssueRelation } from './issue-relation-write'

describe('writeIssueRelation', () => {
  it('does not create a relation when the duplicate lookup omits pageInfo', async () => {
    rawRequest.mockImplementation(async (query: string) =>
      query.includes('issueRelationCreate')
        ? {
            data: {
              issueRelationCreate: {
                success: true,
                issueRelation: {
                  id: 'rel-new',
                  type: 'blocks',
                  issue: { id: 'issue-1' },
                  relatedIssue: { id: 'issue-2' }
                }
              }
            }
          }
        : { data: { issue: { relations: { nodes: [] } } } }
    )
    const issue = { id: 'issue-1', identifier: 'LIN-1', title: 'One', url: 'https://x/1' }
    const relatedIssue = { id: 'issue-2', identifier: 'LIN-2', title: 'Two', url: 'https://x/2' }

    await expect(
      writeIssueRelation({
        issue,
        relatedIssue,
        relationship: 'blocks',
        operation: 'add',
        workspaceId: 'workspace-1'
      })
    ).rejects.toMatchObject({ code: 'linear_partial' })
    expect(rawRequest).toHaveBeenCalledTimes(1)
  })
})
