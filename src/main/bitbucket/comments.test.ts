import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requestHostedReviewJson } from '../source-control/hosted-review-api-request'
import { resolveBitbucketAuthConfig } from './resolve-auth'
import { getBitbucketRepoRef } from './repository-ref'
import {
  addBitbucketPRComment,
  BitbucketInsecureUrlError,
  fetchBitbucketPRComments,
  mapBitbucketComment,
  mapBitbucketComments,
  replyBitbucketPRComment,
  type RawBitbucketComment
} from './comments'

vi.mock('../source-control/hosted-review-api-request', () => ({
  HostedReviewApiRequestError: class HostedReviewApiRequestError extends Error {
    readonly status: number | null
    readonly timedOut: boolean
    constructor(message: string, options: { status?: number | null; timedOut?: boolean } = {}) {
      super(message)
      this.status = options.status ?? null
      this.timedOut = options.timedOut ?? false
    }
  },
  requestHostedReviewJson: vi.fn()
}))

vi.mock('./resolve-auth', () => ({
  resolveBitbucketAuthConfig: vi.fn()
}))

vi.mock('./repository-ref', () => ({
  getBitbucketRepoRef: vi.fn()
}))

describe('Bitbucket comments', () => {
  const mockRepo = {
    workspace: 'my-workspace',
    repoSlug: 'my-repo'
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveBitbucketAuthConfig).mockReturnValue({
      baseUrl: 'https://api.bitbucket.org/2.0',
      accessToken: 'test-token',
      email: null,
      apiToken: null
    })
    vi.mocked(getBitbucketRepoRef).mockResolvedValue(mockRepo)
  })

  describe('mapBitbucketComment', () => {
    it('maps conversation comment fields correctly', () => {
      const raw: RawBitbucketComment = {
        id: 101,
        created_on: '2026-03-26T10:00:00Z',
        content: { raw: 'Top-level comment' },
        user: {
          nickname: 'aiden',
          display_name: 'Aiden Kim',
          links: { avatar: { href: 'https://avatar.example.com/aiden' } }
        },
        links: { html: { href: 'https://bitbucket.org/ws/repo/pull-requests/1#comment-101' } }
      }

      const comment = mapBitbucketComment(raw)

      expect(comment).toEqual({
        id: 101,
        author: 'aiden',
        authorAvatarUrl: 'https://avatar.example.com/aiden',
        body: 'Top-level comment',
        createdAt: '2026-03-26T10:00:00Z',
        url: 'https://bitbucket.org/ws/repo/pull-requests/1#comment-101',
        threadId: '101',
        path: undefined,
        line: undefined,
        isOutdated: undefined,
        isResolved: undefined,
        isBot: false
      })
    })

    it('falls back to display_name or unknown when nickname is missing', () => {
      const rawWithDisplayName: RawBitbucketComment = {
        id: 102,
        user: { display_name: 'Bob Dev' }
      }
      expect(mapBitbucketComment(rawWithDisplayName).author).toBe('Bob Dev')

      const rawWithNoUser: RawBitbucketComment = {
        id: 103
      }
      expect(mapBitbucketComment(rawWithNoUser).author).toBe('unknown')
    })

    it('detects bot authors', () => {
      expect(
        mapBitbucketComment({
          id: 1,
          user: { account_type: 'bot', nickname: 'ci-bot' }
        }).isBot
      ).toBe(true)

      expect(
        mapBitbucketComment({
          id: 2,
          user: { type: 'bot', nickname: 'helper' }
        }).isBot
      ).toBe(true)

      expect(
        mapBitbucketComment({
          id: 3,
          user: { nickname: 'code-review[bot]' }
        }).isBot
      ).toBe(true)

      expect(
        mapBitbucketComment({
          id: 4,
          user: { nickname: 'normal-user' }
        }).isBot
      ).toBe(false)
    })

    it('maps inline comments and marks isResolved as false', () => {
      const raw: RawBitbucketComment = {
        id: 201,
        content: { raw: 'Code comment' },
        inline: {
          path: 'src/main.ts',
          to: 42,
          from: null,
          out_dated: false
        }
      }

      const comment = mapBitbucketComment(raw)
      expect(comment.path).toBe('src/main.ts')
      expect(comment.line).toBe(42)
      expect(comment.isOutdated).toBe(false)
      expect(comment.isResolved).toBe(false)
    })

    it('uses from line when to is null', () => {
      const raw: RawBitbucketComment = {
        id: 202,
        inline: {
          path: 'src/old.ts',
          to: null,
          from: 15
        }
      }
      expect(mapBitbucketComment(raw).line).toBe(15)
    })
  })

  describe('mapBitbucketComments', () => {
    it('groups multi-level replies under the root threadId and inherits inline info', () => {
      const rawComments: RawBitbucketComment[] = [
        {
          id: 10,
          created_on: '2026-03-26T10:00:00Z',
          content: { raw: 'Root inline comment' },
          inline: { path: 'src/index.ts', to: 25 }
        },
        {
          id: 11,
          created_on: '2026-03-26T10:05:00Z',
          content: { raw: 'First reply' },
          parent: { id: 10 }
        },
        {
          id: 12,
          created_on: '2026-03-26T10:10:00Z',
          content: { raw: 'Reply to first reply' },
          parent: { id: 11 }
        }
      ]

      const comments = mapBitbucketComments(rawComments)

      expect(comments).toHaveLength(3)
      expect(comments[0].threadId).toBe('10')
      expect(comments[0].path).toBe('src/index.ts')
      expect(comments[0].line).toBe(25)

      expect(comments[1].threadId).toBe('10')
      expect(comments[1].path).toBe('src/index.ts')
      expect(comments[1].line).toBe(25)

      expect(comments[2].threadId).toBe('10')
      expect(comments[2].path).toBe('src/index.ts')
      expect(comments[2].line).toBe(25)
    })

    it('filters out deleted comments with no replies', () => {
      const rawComments: RawBitbucketComment[] = [
        { id: 1, content: { raw: 'Keep me' } },
        { id: 2, deleted: true, content: { raw: '' } }
      ]

      const comments = mapBitbucketComments(rawComments)
      expect(comments).toHaveLength(1)
      expect(comments[0].id).toBe(1)
    })

    it('keeps deleted comments that have replies', () => {
      const rawComments: RawBitbucketComment[] = [
        { id: 1, deleted: true, content: { raw: '' } },
        { id: 2, content: { raw: 'Reply to deleted' }, parent: { id: 1 } }
      ]

      const comments = mapBitbucketComments(rawComments)
      expect(comments).toHaveLength(2)
      expect(comments[0].id).toBe(1)
      expect(comments[1].threadId).toBe('1')
    })

    it('maps isResolved: true and propagates resolution state to thread replies', () => {
      const rawComments: RawBitbucketComment[] = [
        {
          id: 10,
          content: { raw: 'Resolved thread root' },
          inline: { path: 'src/file.ts', to: 15 },
          resolution: { type: 'resolved', created_on: '2026-03-26T12:00:00Z' }
        },
        {
          id: 11,
          content: { raw: 'Reply in resolved thread' },
          parent: { id: 10 }
        },
        {
          id: 20,
          content: { raw: 'Open thread root' },
          inline: { path: 'src/file.ts', to: 30 }
        },
        {
          id: 21,
          content: { raw: 'Reply in open thread' },
          parent: { id: 20 }
        }
      ]

      const comments = mapBitbucketComments(rawComments)
      expect(comments).toHaveLength(4)
      expect(comments[0].isResolved).toBe(true)
      expect(comments[1].isResolved).toBe(true)
      expect(comments[2].isResolved).toBe(false)
      expect(comments[3].isResolved).toBe(false)
    })
  })

  describe('fetchBitbucketPRComments', () => {
    it('returns empty array when not authenticated', async () => {
      vi.mocked(resolveBitbucketAuthConfig).mockReturnValue({
        baseUrl: 'https://api.bitbucket.org/2.0',
        accessToken: null,
        email: null,
        apiToken: null
      })

      const comments = await fetchBitbucketPRComments('/repo/path', 42)
      expect(comments).toEqual([])
      expect(requestHostedReviewJson).not.toHaveBeenCalled()
    })

    it('returns empty array when repo cannot be resolved', async () => {
      vi.mocked(getBitbucketRepoRef).mockResolvedValue(null)

      const comments = await fetchBitbucketPRComments('/repo/path', 42)
      expect(comments).toEqual([])
      expect(requestHostedReviewJson).not.toHaveBeenCalled()
    })

    it('fetches single page of comments and maps them', async () => {
      vi.mocked(requestHostedReviewJson).mockResolvedValueOnce({
        values: [
          {
            id: 1,
            content: { raw: 'LGTM' },
            user: { nickname: 'reviewer' }
          }
        ]
      })

      const comments = await fetchBitbucketPRComments('/repo/path', 42)
      expect(comments).toHaveLength(1)
      expect(comments[0].id).toBe(1)
      expect(comments[0].author).toBe('reviewer')
      expect(comments[0].body).toBe('LGTM')
      expect(requestHostedReviewJson).toHaveBeenCalledWith(
        new URL(
          'https://api.bitbucket.org/2.0/repositories/my-workspace/my-repo/pullrequests/42/comments?pagelen=100&fields=%2Bvalues.resolution'
        ),
        expect.objectContaining({
          method: 'GET',
          redirect: 'error',
          headers: expect.objectContaining({
            Authorization: 'Bearer test-token'
          })
        }),
        30_000
      )
    })

    it('follows pagination when next URL is returned', async () => {
      vi.mocked(requestHostedReviewJson)
        .mockResolvedValueOnce({
          values: [{ id: 1, content: { raw: 'Page 1' } }],
          next: 'https://api.bitbucket.org/2.0/repositories/my-workspace/my-repo/pullrequests/42/comments?page=2'
        })
        .mockResolvedValueOnce({
          values: [{ id: 2, content: { raw: 'Page 2' } }]
        })

      const comments = await fetchBitbucketPRComments('/repo/path', 42)
      expect(comments).toHaveLength(2)
      expect(comments[0].id).toBe(1)
      expect(comments[1].id).toBe(2)
      expect(requestHostedReviewJson).toHaveBeenCalledTimes(2)
    })

    it('throws when baseUrl is not HTTPS', async () => {
      vi.mocked(resolveBitbucketAuthConfig).mockReturnValue({
        baseUrl: 'http://insecure.bitbucket.org/2.0',
        accessToken: 'token',
        email: null,
        apiToken: null
      })

      await expect(fetchBitbucketPRComments('/repo/path', 42)).rejects.toThrow(
        BitbucketInsecureUrlError
      )
    })

    it('stops pagination when nextUrl points to an unexpected origin', async () => {
      vi.mocked(requestHostedReviewJson).mockResolvedValueOnce({
        values: [{ id: 1, content: { raw: 'Page 1' } }],
        next: 'https://evil.com/2.0/repositories/my-workspace/my-repo/pullrequests/42/comments?page=2'
      })

      const comments = await fetchBitbucketPRComments('/repo/path', 42)
      expect(comments).toHaveLength(1)
      expect(comments[0].id).toBe(1)
      expect(requestHostedReviewJson).toHaveBeenCalledTimes(1)
      expect(requestHostedReviewJson).toHaveBeenCalledWith(
        expect.any(URL),
        expect.objectContaining({ redirect: 'error' }),
        30_000
      )
    })

    it('returns empty array when API request throws', async () => {
      vi.mocked(requestHostedReviewJson).mockRejectedValueOnce(new Error('Network error'))

      const comments = await fetchBitbucketPRComments('/repo/path', 42)
      expect(comments).toEqual([])
    })
  })

  describe('addBitbucketPRComment', () => {
    it('successfully posts comment and returns mapped result', async () => {
      vi.mocked(requestHostedReviewJson).mockResolvedValueOnce({
        id: 50,
        content: { raw: 'New comment' },
        user: { nickname: 'me' }
      })

      const result = await addBitbucketPRComment('/repo/path', 42, 'New comment')

      expect(result).toEqual({
        ok: true,
        comment: expect.objectContaining({
          id: 50,
          author: 'me',
          body: 'New comment',
          threadId: '50'
        })
      })
      expect(requestHostedReviewJson).toHaveBeenCalledWith(
        new URL(
          'https://api.bitbucket.org/2.0/repositories/my-workspace/my-repo/pullrequests/42/comments'
        ),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-token'
          }),
          body: JSON.stringify({ content: { raw: 'New comment' } })
        }),
        30_000
      )
    })

    it('returns error when not authenticated', async () => {
      vi.mocked(resolveBitbucketAuthConfig).mockReturnValue({
        baseUrl: 'https://api.bitbucket.org/2.0',
        accessToken: null,
        email: null,
        apiToken: null
      })

      const result = await addBitbucketPRComment('/repo/path', 42, 'comment')
      expect(result).toEqual({
        ok: false,
        error:
          'Commenting failed: Bitbucket is not connected. Connect Bitbucket in Settings > Integrations.'
      })
    })

    it('returns error when request fails', async () => {
      vi.mocked(requestHostedReviewJson).mockRejectedValueOnce(
        new Error(JSON.stringify({ error: { message: 'Rate limit exceeded' } }))
      )

      const result = await addBitbucketPRComment('/repo/path', 42, 'comment')
      expect(result).toEqual({
        ok: false,
        error: 'Failed to add comment: Rate limit exceeded'
      })
    })
  })

  describe('replyBitbucketPRComment', () => {
    it('successfully posts reply with parent id', async () => {
      vi.mocked(requestHostedReviewJson).mockResolvedValueOnce({
        id: 51,
        content: { raw: 'A reply' },
        parent: { id: 50 },
        user: { nickname: 'me' }
      })

      const result = await replyBitbucketPRComment('/repo/path', 42, 50, 'A reply')

      expect(result).toEqual({
        ok: true,
        comment: expect.objectContaining({
          id: 51,
          body: 'A reply',
          threadId: '50'
        })
      })
      expect(requestHostedReviewJson).toHaveBeenCalledWith(
        new URL(
          'https://api.bitbucket.org/2.0/repositories/my-workspace/my-repo/pullrequests/42/comments'
        ),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            content: { raw: 'A reply' },
            parent: { id: 50 }
          })
        }),
        30_000
      )
    })

    it('returns error when reply fails', async () => {
      vi.mocked(requestHostedReviewJson).mockRejectedValueOnce(
        new Error('Failed to reach Bitbucket')
      )

      const result = await replyBitbucketPRComment('/repo/path', 42, 50, 'A reply')
      expect(result).toEqual({
        ok: false,
        error: 'Failed to reply to comment: Failed to reach Bitbucket'
      })
    })

    it('uses rootCommentId for threadId when provided', async () => {
      vi.mocked(requestHostedReviewJson).mockResolvedValueOnce({
        id: 52,
        content: { raw: 'Reply to reply' },
        parent: { id: 51 },
        user: { nickname: 'me' }
      })

      const result = await replyBitbucketPRComment(
        '/repo/path',
        42,
        51,
        'Reply to reply',
        null,
        {},
        50
      )

      expect(result).toEqual({
        ok: true,
        comment: expect.objectContaining({
          id: 52,
          body: 'Reply to reply',
          threadId: '50'
        })
      })
    })
  })
})
