import { beforeEach, describe, expect, it, vi } from 'vitest'

const { requestGiteaJsonMock } = vi.hoisted(() => ({
  requestGiteaJsonMock: vi.fn()
}))

vi.mock('./client', () => ({
  requestGiteaJson: requestGiteaJsonMock
}))

import { fetchGiteaIssueComments, fetchGiteaPRCommentsAndReviews } from './pr-discussion-comments'

const repo = {
  host: 'git.example.com',
  owner: 'team',
  repo: 'widgets',
  apiBaseUrl: 'https://git.example.com/api/v1',
  webBaseUrl: 'https://git.example.com',
  loginName: 'work'
}

const page = { searchParams: { limit: 100 } }

describe('fetchGiteaIssueComments', () => {
  beforeEach(() => {
    requestGiteaJsonMock.mockReset()
  })

  it('maps timeline comments from the shared issue comments endpoint', async () => {
    requestGiteaJsonMock.mockResolvedValue([
      {
        id: 20,
        body: 'later note',
        html_url: 'https://git.example.com/team/widgets/issues/7#issuecomment-20',
        created_at: '2026-05-02T00:00:00Z',
        user: { login: 'alice', avatar_url: 'https://example.com/alice.png' }
      },
      {
        id: 10,
        body: 'bot note',
        html_url: 'https://git.example.com/team/widgets/issues/7#issuecomment-10',
        created_at: '2026-05-01T00:00:00Z',
        user: { login: 'ci[bot]', avatar_url: 'https://example.com/bot.png' }
      }
    ])

    const comments = await fetchGiteaIssueComments(repo, 7)

    expect(requestGiteaJsonMock).toHaveBeenCalledWith(
      repo,
      '/repos/team/widgets/issues/7/comments',
      page
    )
    expect(comments).toEqual([
      {
        id: 10,
        author: 'ci[bot]',
        authorAvatarUrl: 'https://example.com/bot.png',
        body: 'bot note',
        createdAt: '2026-05-01T00:00:00Z',
        url: 'https://git.example.com/team/widgets/issues/7#issuecomment-10',
        isBot: true
      },
      {
        id: 20,
        author: 'alice',
        authorAvatarUrl: 'https://example.com/alice.png',
        body: 'later note',
        createdAt: '2026-05-02T00:00:00Z',
        url: 'https://git.example.com/team/widgets/issues/7#issuecomment-20',
        isBot: false
      }
    ])
  })
})

describe('fetchGiteaPRCommentsAndReviews', () => {
  beforeEach(() => {
    requestGiteaJsonMock.mockReset()
  })

  it('merges timeline comments, review summaries, and inline threads in chronological order', async () => {
    requestGiteaJsonMock.mockImplementation(async (_repo: unknown, path: string) => {
      if (path === '/repos/team/widgets/issues/8/comments') {
        return [
          {
            id: 30,
            body: 'general comment',
            html_url: 'https://git.example.com/team/widgets/issues/8#issuecomment-30',
            created_at: '2026-05-03T00:00:00Z',
            user: { username: 'erin' }
          }
        ]
      }
      if (path === '/repos/team/widgets/pulls/8/reviews') {
        return [
          {
            id: 2,
            body: 'LGTM',
            html_url: 'https://git.example.com/team/widgets/pulls/8#pullreview-2',
            submitted_at: '2026-05-02T00:00:00Z',
            state: 'APPROVED',
            user: { id: 1, login: 'alice', avatar_url: 'https://example.com/alice.png' }
          },
          {
            id: 4,
            body: '',
            html_url: 'https://git.example.com/team/widgets/pulls/8#pullreview-4',
            submitted_at: '2026-05-04T00:00:00Z',
            state: 'REQUEST_CHANGES',
            user: { id: 2, login: 'bob' }
          }
        ]
      }
      if (path === '/repos/team/widgets/pulls/8/reviews/2/comments') {
        return [
          {
            id: 50,
            body: 'nit on the new line',
            html_url: 'https://git.example.com/team/widgets/pulls/8#issuecomment-50',
            created_at: '2026-05-02T01:00:00Z',
            path: 'src/app.ts',
            position: 12,
            old_position: 0,
            resolver: null,
            user: { login: 'alice', avatar_url: 'https://example.com/alice.png' }
          }
        ]
      }
      if (path === '/repos/team/widgets/pulls/8/reviews/4/comments') {
        return [
          {
            id: 60,
            body: 'resolved on the old line',
            html_url: 'https://git.example.com/team/widgets/pulls/8#issuecomment-60',
            created_at: '2026-05-01T00:00:00Z',
            path: 'src/old.ts',
            position: 0,
            old_position: 4,
            resolver: { login: 'mod' },
            reviewer: { login: 'bob', avatar_url: 'https://example.com/bob.png' }
          }
        ]
      }
      throw new Error(`unexpected Gitea path: ${path}`)
    })

    const result = await fetchGiteaPRCommentsAndReviews(repo, 8)

    expect(requestGiteaJsonMock).toHaveBeenCalledWith(
      repo,
      '/repos/team/widgets/issues/8/comments',
      page
    )
    expect(requestGiteaJsonMock).toHaveBeenCalledWith(
      repo,
      '/repos/team/widgets/pulls/8/reviews',
      page
    )
    expect(requestGiteaJsonMock).toHaveBeenCalledWith(
      repo,
      '/repos/team/widgets/pulls/8/reviews/4/comments',
      page
    )
    expect(result.reviews).toEqual([
      {
        id: 2,
        body: 'LGTM',
        html_url: 'https://git.example.com/team/widgets/pulls/8#pullreview-2',
        submitted_at: '2026-05-02T00:00:00Z',
        state: 'APPROVED',
        dismissed: false,
        user: { id: 1, login: 'alice', avatar_url: 'https://example.com/alice.png' }
      },
      {
        id: 4,
        body: '',
        html_url: 'https://git.example.com/team/widgets/pulls/8#pullreview-4',
        submitted_at: '2026-05-04T00:00:00Z',
        state: 'REQUEST_CHANGES',
        dismissed: false,
        user: { id: 2, login: 'bob', avatar_url: '' }
      }
    ])
    expect(result.comments).toEqual([
      {
        id: 60,
        author: 'bob',
        authorAvatarUrl: 'https://example.com/bob.png',
        body: 'resolved on the old line',
        createdAt: '2026-05-01T00:00:00Z',
        url: 'https://git.example.com/team/widgets/pulls/8#issuecomment-60',
        isBot: false,
        threadId: '60',
        isResolved: true,
        path: 'src/old.ts',
        line: 4
      },
      {
        id: 2,
        author: 'alice',
        authorAvatarUrl: 'https://example.com/alice.png',
        body: 'LGTM',
        createdAt: '2026-05-02T00:00:00Z',
        url: 'https://git.example.com/team/widgets/pulls/8#pullreview-2',
        isBot: false,
        threadId: '2'
      },
      {
        id: 50,
        author: 'alice',
        authorAvatarUrl: 'https://example.com/alice.png',
        body: 'nit on the new line',
        createdAt: '2026-05-02T01:00:00Z',
        url: 'https://git.example.com/team/widgets/pulls/8#issuecomment-50',
        isBot: false,
        threadId: '50',
        isResolved: false,
        path: 'src/app.ts',
        line: 12
      },
      {
        id: 30,
        author: 'erin',
        authorAvatarUrl: '',
        body: 'general comment',
        createdAt: '2026-05-03T00:00:00Z',
        url: 'https://git.example.com/team/widgets/issues/8#issuecomment-30',
        isBot: false
      }
    ])
  })
})
