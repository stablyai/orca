import { beforeEach, describe, expect, it, vi } from 'vitest'

const rawRequest = vi.fn()
const getClients = vi.fn()

vi.mock('./linear-request-concurrency', () => ({
  acquire: vi.fn().mockResolvedValue(undefined),
  release: vi.fn()
}))

vi.mock('./linear-token-store', () => ({
  clearToken: vi.fn()
}))

vi.mock('./client', () => ({
  getClients: (...args: unknown[]) => getClients(...args),
  isAuthError: () => false
}))

function rawComment(id: string, body: string, createdAt: string) {
  return { id, body, createdAt, user: { displayName: 'Ada', avatarUrl: null } }
}

describe('getIssueComments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getClients.mockReturnValue([
      { workspace: { id: 'workspace-1' }, client: { client: { rawRequest } } }
    ])
  })

  it('returns comments oldest first, although Linear sends them newest first', async () => {
    rawRequest.mockResolvedValueOnce({
      data: {
        issue: {
          comments: {
            nodes: [
              rawComment('comment-3', 'Third', '2026-01-02T03:06:05.000Z'),
              rawComment('comment-2', 'Second', '2026-01-02T03:05:05.000Z'),
              rawComment('comment-1', 'First', '2026-01-02T03:04:05.000Z')
            ]
          }
        }
      }
    })
    const { getIssueComments } = await import('./linear-issue-comments')

    const comments = await getIssueComments('issue-uuid', 'workspace-1')

    expect(comments.map((comment) => comment.body)).toEqual(['First', 'Second', 'Third'])
  })
})
