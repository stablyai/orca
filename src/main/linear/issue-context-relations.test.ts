import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedIssue } from './issue-context-client'

const rawRequest = vi.fn()

vi.mock('./issue-context-client', () => ({
  getRequiredEntry: () => ({ client: { client: { rawRequest } } }),
  withLinearRead: async (_entry: unknown, read: () => Promise<unknown>) => read()
}))

function resolvedIssue(): ResolvedIssue {
  return {
    issue: {
      id: 'issue-1',
      identifier: 'ENG-1',
      title: 'Current',
      url: 'https://linear.app/acme/issue/ENG-1',
      labels: []
    },
    workspace: {
      id: 'workspace-1',
      organizationId: 'workspace-1',
      organizationName: 'Acme',
      displayName: 'Ada',
      email: 'ada@example.com'
    }
  }
}

function rawIssue(id: string, identifier: string) {
  return {
    id,
    identifier,
    title: `Issue ${identifier}`,
    url: `https://linear.app/acme/issue/${identifier}`
  }
}

describe('Linear issue context relations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns outbound and inverse relations from the current issue perspective', async () => {
    rawRequest
      .mockResolvedValueOnce({
        data: {
          issue: {
            relations: {
              nodes: [
                { id: 'relation-1', type: 'blocks', relatedIssue: rawIssue('issue-2', 'ENG-2') }
              ],
              pageInfo: { hasNextPage: false }
            }
          }
        }
      })
      .mockResolvedValueOnce({
        data: {
          issue: {
            inverseRelations: {
              nodes: [
                { id: 'relation-2', type: 'blocks', issue: rawIssue('issue-3', 'ENG-3') },
                { id: 'relation-3', type: 'duplicate', issue: rawIssue('issue-4', 'ENG-4') }
              ],
              pageInfo: { hasNextPage: false }
            }
          }
        }
      })
    const { readIssueRelations } = await import('./issue-context-relations')

    const result = await readIssueRelations(resolvedIssue())

    expect(result.items).toEqual([
      expect.objectContaining({
        id: 'relation-1',
        direction: 'outbound',
        relationship: 'blocks',
        relatedIssue: expect.objectContaining({ identifier: 'ENG-2' })
      }),
      expect.objectContaining({
        id: 'relation-2',
        direction: 'inbound',
        relationship: 'blockedBy',
        relatedIssue: expect.objectContaining({ identifier: 'ENG-3' })
      }),
      expect.objectContaining({
        id: 'relation-3',
        direction: 'inbound',
        relationship: 'duplicatedBy',
        relatedIssue: expect.objectContaining({ identifier: 'ENG-4' })
      })
    ])
    expect(result.meta).toMatchObject({ returned: 3, cap: 100, capReached: false })
    expect(rawRequest).toHaveBeenCalledTimes(2)
  })

  it('reports hidden inverse relations when outbound relations exactly fill the cap', async () => {
    const outbound = (offset: number) =>
      Array.from({ length: 50 }, (_, index) => ({
        id: `relation-${offset + index}`,
        type: 'blocks',
        relatedIssue: rawIssue(`issue-${offset + index + 10}`, `ENG-${offset + index + 10}`)
      }))
    rawRequest
      .mockResolvedValueOnce({
        data: {
          issue: {
            relations: {
              nodes: outbound(0),
              pageInfo: { hasNextPage: true, endCursor: 'cursor-1' }
            }
          }
        }
      })
      .mockResolvedValueOnce({
        data: {
          issue: {
            relations: {
              nodes: outbound(50),
              pageInfo: { hasNextPage: false }
            }
          }
        }
      })
      .mockResolvedValueOnce({
        data: {
          issue: {
            inverseRelations: {
              nodes: [
                { id: 'hidden-inverse', type: 'blocks', issue: rawIssue('issue-2', 'ENG-2') }
              ],
              pageInfo: { hasNextPage: false }
            }
          }
        }
      })
    const { readIssueRelations } = await import('./issue-context-relations')

    const result = await readIssueRelations(resolvedIssue())

    expect(result.items).toHaveLength(100)
    expect(result.meta).toMatchObject({ returned: 100, capReached: true, hasMore: true })
    expect(rawRequest.mock.calls[2]?.[1]).toMatchObject({ first: 1 })
  })
})
