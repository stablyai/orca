import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { resolveGiteaIssueSourceMock, requestGiteaJsonMock, teaExecFileAsyncMock } = vi.hoisted(
  () => ({
    resolveGiteaIssueSourceMock: vi.fn(),
    requestGiteaJsonMock: vi.fn(),
    teaExecFileAsyncMock: vi.fn()
  })
)

vi.mock('./gitea-issue-source-resolution', () => ({
  resolveGiteaIssueSource: resolveGiteaIssueSourceMock
}))

vi.mock('./gitea-json-request', () => ({
  requestGiteaJson: requestGiteaJsonMock,
  configuredGiteaApiBaseUrl: (repo: { apiBaseUrl: string }) => repo.apiBaseUrl
}))

vi.mock('../git/runner', () => ({
  teaExecFileAsync: teaExecFileAsyncMock
}))

import {
  addGiteaPRComment,
  addGiteaPRInlineComment,
  resolveGiteaPRDiscussion,
  submitGiteaPRReview
} from './pull-request-review-mutations'

const repo = {
  host: 'git.example.com',
  owner: 'team',
  repo: 'widgets',
  apiBaseUrl: 'https://git.example.com/api/v1',
  webBaseUrl: 'https://git.example.com',
  loginName: 'work'
}

const createdComment = {
  id: 44,
  body: 'Ship the widget',
  created_at: '2026-10-29T12:00:00Z',
  html_url: 'https://git.example.com/team/widgets/issues/12#issuecomment-44',
  user: { login: 'ada', avatar_url: 'https://git.example.com/avatars/ada' }
}

const OLD_ENV = process.env

describe('Gitea pull request review mutations', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    delete process.env.ORCA_GITEA_TOKEN
    delete process.env.GITEA_TOKEN
    delete process.env.ORCA_GITEA_API_BASE_URL
    delete process.env.GITEA_INSTANCE_URL
    resolveGiteaIssueSourceMock.mockReset()
    resolveGiteaIssueSourceMock.mockResolvedValue({ source: repo, fellBack: false })
    requestGiteaJsonMock.mockReset()
    teaExecFileAsyncMock.mockReset()
    teaExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify(createdComment),
      stderr: ''
    })
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    process.env = OLD_ENV
    vi.unstubAllGlobals()
  })

  it('posts a top-level comment with tea api and maps the created comment', async () => {
    await expect(addGiteaPRComment('/repo', 12, 'Ship the widget')).resolves.toEqual({
      ok: true,
      comment: {
        id: 44,
        author: 'ada',
        authorAvatarUrl: 'https://git.example.com/avatars/ada',
        body: 'Ship the widget',
        createdAt: '2026-10-29T12:00:00Z',
        url: 'https://git.example.com/team/widgets/issues/12#issuecomment-44',
        isBot: false
      }
    })
    expect(teaExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        '-X',
        'POST',
        '/repos/team/widgets/issues/12/comments',
        '-f',
        'body=Ship the widget',
        '--repo',
        'team/widgets',
        '--login',
        'work'
      ],
      expect.objectContaining({ idempotent: false, cwd: '/repo' })
    )
  })

  it('rejects an empty comment body before invoking tea', async () => {
    await expect(addGiteaPRComment('/repo', 12, '   ')).resolves.toEqual({
      ok: false,
      error: 'Comment body is required.'
    })
    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('rejects a missing pull index before invoking tea', async () => {
    await expect(addGiteaPRComment('/repo', 0, 'hello')).resolves.toEqual({
      ok: false,
      error: 'Pull request index must be a positive integer.'
    })
    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('posts the comment over HTTP when a token is set', async () => {
    process.env.ORCA_GITEA_TOKEN = 'gitea-token'
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      expect(JSON.parse(String(init?.body))).toEqual({ body: 'Ship the widget' })
      expect(new Headers(init?.headers).get('Authorization')).toBe('token gitea-token')
      return new Response(JSON.stringify(createdComment), { status: 201 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(addGiteaPRComment('/repo', 12, 'Ship the widget')).resolves.toMatchObject({
      ok: true,
      comment: { id: 44, author: 'ada', body: 'Ship the widget' }
    })
    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://git.example.com/api/v1/repos/team/widgets/issues/12/comments'
    )
  })

  it('requires authentication when neither a token nor a tea login is available', async () => {
    resolveGiteaIssueSourceMock.mockResolvedValue({
      source: { ...repo, loginName: null },
      fellBack: false
    })

    await expect(addGiteaPRComment('/repo', 12, 'hello')).resolves.toEqual({
      ok: false,
      error: 'Gitea is not authenticated. Set ORCA_GITEA_TOKEN or run tea login add.'
    })
    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('creates an inline diff comment through the reviews API and keeps the comment id as the thread', async () => {
    const review = {
      id: 9,
      comments: [
        {
          id: 77,
          body: 'Check this line',
          path: 'src/a.ts',
          position: 4,
          created_at: '2026-10-29T12:01:00Z',
          html_url: 'https://git.example.com/team/widgets/pulls/12#issuecomment-77',
          user: { login: 'ada', avatar_url: 'https://git.example.com/avatars/ada' }
        }
      ]
    }
    teaExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify(review), stderr: '' })

    await expect(
      addGiteaPRInlineComment('/repo', 12, {
        body: 'Check this line',
        path: 'src/a.ts',
        line: 4,
        headSha: 'abc123'
      })
    ).resolves.toEqual({
      ok: true,
      comment: {
        id: 77,
        author: 'ada',
        authorAvatarUrl: 'https://git.example.com/avatars/ada',
        body: 'Check this line',
        createdAt: '2026-10-29T12:01:00Z',
        url: 'https://git.example.com/team/widgets/pulls/12#issuecomment-77',
        isBot: false,
        threadId: '77',
        isResolved: false,
        path: 'src/a.ts',
        line: 4
      }
    })
    const args = teaExecFileAsyncMock.mock.calls[0]?.[0]
    expect(args?.slice(0, 3)).toEqual(['api', '-X', 'POST'])
    expect(args).not.toContain('review')
    expect(args?.[3]).toBe('/repos/team/widgets/pulls/12/reviews')
    expect(args?.[4]).toBe('-d')
    expect(JSON.parse(String(args?.[5]))).toEqual({
      event: 'COMMENT',
      commit_id: 'abc123',
      comments: [{ path: 'src/a.ts', new_position: 4, body: 'Check this line' }]
    })
  })

  it('reads the created review comment when the review response omits comments', async () => {
    teaExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify({ id: 9 }), stderr: '' })
    requestGiteaJsonMock.mockResolvedValue([
      {
        id: 77,
        body: 'Check this line',
        path: 'src/a.ts',
        new_position: 4,
        created_at: '2026-10-29T12:01:00Z',
        html_url: 'https://git.example.com/team/widgets/pulls/12#issuecomment-77',
        user: { login: 'ada', avatar_url: 'https://git.example.com/avatars/ada' }
      }
    ])

    await expect(
      addGiteaPRInlineComment('/repo', 12, {
        body: 'Check this line',
        path: 'src/a.ts',
        line: 4,
        headSha: 'abc123'
      })
    ).resolves.toMatchObject({ ok: true, comment: { id: 77, threadId: '77', line: 4 } })
    expect(requestGiteaJsonMock).toHaveBeenCalledWith(
      repo,
      '/repos/team/widgets/pulls/12/reviews/9/comments'
    )
  })

  it('replies on an existing thread with tea pr reply', async () => {
    teaExecFileAsyncMock.mockResolvedValue({
      stdout: 'https://git.example.com/team/widgets/pulls/12#issuecomment-88\n',
      stderr: ''
    })

    await expect(
      addGiteaPRInlineComment('/repo', 12, {
        body: 'Follow up',
        path: 'src/a.ts',
        line: 4,
        headSha: 'abc123',
        replyToCommentId: '77'
      })
    ).resolves.toEqual({
      ok: true,
      comment: {
        id: 88,
        author: 'unknown',
        authorAvatarUrl: '',
        body: 'Follow up',
        createdAt: '',
        url: 'https://git.example.com/team/widgets/pulls/12#issuecomment-88',
        isBot: false,
        threadId: '88',
        isResolved: false
      }
    })
    expect(teaExecFileAsyncMock).toHaveBeenCalledWith(
      ['pr', 'reply', '12', '77', 'Follow up', '--repo', 'team/widgets', '--login', 'work'],
      expect.objectContaining({ idempotent: false, cwd: '/repo' })
    )
  })

  it('rejects an inline comment that is missing a line anchor', async () => {
    await expect(
      addGiteaPRInlineComment('/repo', 12, {
        body: 'Check this line',
        path: 'src/a.ts',
        line: 0,
        headSha: 'abc123'
      })
    ).resolves.toEqual({
      ok: false,
      error: 'Inline comment line must be a positive integer.'
    })
    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('rejects a thread reply whose comment id is not a positive integer', async () => {
    await expect(
      addGiteaPRInlineComment('/repo', 12, {
        body: 'Follow up',
        path: 'src/a.ts',
        line: 4,
        headSha: 'abc123',
        replyToCommentId: 'nope'
      })
    ).resolves.toEqual({
      ok: false,
      error: 'Reply comment id must be a positive integer.'
    })
    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('posts a new inline comment and a thread reply over HTTP when a token is set', async () => {
    process.env.ORCA_GITEA_TOKEN = 'gitea-token'
    const reply = {
      id: 88,
      body: 'Follow up',
      created_at: '2026-10-29T12:02:00Z',
      html_url: 'https://git.example.com/team/widgets/pulls/12#issuecomment-88',
      user: { login: 'ada', avatar_url: 'https://git.example.com/avatars/ada' }
    }
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/reviews')) {
        return new Response(
          JSON.stringify({
            id: 9,
            comments: [
              {
                id: 77,
                body: 'Check this line',
                path: 'src/a.ts',
                position: 4,
                created_at: '2026-10-29T12:01:00Z',
                html_url: 'https://git.example.com/team/widgets/pulls/12#issuecomment-77',
                user: { login: 'ada', avatar_url: 'https://git.example.com/avatars/ada' }
              }
            ]
          }),
          { status: 201 }
        )
      }
      expect(JSON.parse(String(init?.body))).toEqual({ body: 'Follow up' })
      return new Response(JSON.stringify(reply), { status: 201 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      addGiteaPRInlineComment('/repo', 12, {
        body: 'Check this line',
        path: 'src/a.ts',
        line: 4,
        headSha: 'abc123'
      })
    ).resolves.toMatchObject({ ok: true, comment: { id: 77, threadId: '77' } })
    await expect(
      addGiteaPRInlineComment('/repo', 12, {
        body: 'Follow up',
        path: 'src/a.ts',
        line: 4,
        headSha: 'abc123',
        replyToCommentId: '77'
      })
    ).resolves.toMatchObject({ ok: true, comment: { id: 88, author: 'ada', threadId: '88' } })
    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://git.example.com/api/v1/repos/team/widgets/pulls/12/comments/77/replies'
    )
  })

  it('resolves and unresolves a review thread by positive integer comment id', async () => {
    await expect(resolveGiteaPRDiscussion('/repo', 12, '77', true)).resolves.toEqual({ ok: true })
    await expect(resolveGiteaPRDiscussion('/repo', 12, '77', false)).resolves.toEqual({ ok: true })
    expect(teaExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['pr', 'resolve', '77', '--repo', 'team/widgets', '--login', 'work'],
      expect.objectContaining({ idempotent: false, cwd: '/repo' })
    )
    expect(teaExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['pr', 'unresolve', '77', '--repo', 'team/widgets', '--login', 'work'],
      expect.objectContaining({ idempotent: false, cwd: '/repo' })
    )
  })

  it('rejects a discussion id that is not a positive integer before invoking tea', async () => {
    await expect(resolveGiteaPRDiscussion('/repo', 12, '0', true)).resolves.toEqual({
      ok: false,
      error: 'Discussion id must be a positive integer.'
    })
    await expect(resolveGiteaPRDiscussion('/repo', 12, 'thread-1', false)).resolves.toEqual({
      ok: false,
      error: 'Discussion id must be a positive integer.'
    })
    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('resolves a thread over HTTP when a token is set', async () => {
    process.env.ORCA_GITEA_TOKEN = 'gitea-token'
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe('POST')
      return new Response(null, { status: 201 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(resolveGiteaPRDiscussion('/repo', 12, '77', true)).resolves.toEqual({ ok: true })
    await expect(resolveGiteaPRDiscussion('/repo', 12, '77', false)).resolves.toEqual({ ok: true })
    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://git.example.com/api/v1/repos/team/widgets/pulls/comments/77/resolve'
    )
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://git.example.com/api/v1/repos/team/widgets/pulls/comments/77/unresolve'
    )
  })

  it('approves with tea pr approve and requires a comment when requesting changes', async () => {
    await expect(submitGiteaPRReview('/repo', 12, 'approve', 'LGTM')).resolves.toEqual({
      ok: true
    })
    await expect(submitGiteaPRReview('/repo', 12, 'approve')).resolves.toEqual({ ok: true })
    await expect(
      submitGiteaPRReview('/repo', 12, 'request_changes', 'Needs tests')
    ).resolves.toEqual({ ok: true })
    await expect(submitGiteaPRReview('/repo', 12, 'request_changes', '   ')).resolves.toEqual({
      ok: false,
      error: 'A comment is required when requesting changes.'
    })
    expect(teaExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['pr', 'approve', '12', 'LGTM', '--repo', 'team/widgets', '--login', 'work'],
      expect.objectContaining({ idempotent: false, cwd: '/repo' })
    )
    expect(teaExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['pr', 'approve', '12', '--repo', 'team/widgets', '--login', 'work'],
      expect.objectContaining({ idempotent: false })
    )
    expect(teaExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['pr', 'reject', '12', 'Needs tests', '--repo', 'team/widgets', '--login', 'work'],
      expect.objectContaining({ idempotent: false })
    )
    expect(teaExecFileAsyncMock).toHaveBeenCalledTimes(3)
  })

  it('submits approval and requested changes over HTTP when a token is set', async () => {
    process.env.ORCA_GITEA_TOKEN = 'gitea-token'
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      void init
      return new Response(JSON.stringify({ id: 3 }), { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(submitGiteaPRReview('/repo', 12, 'approve', 'LGTM')).resolves.toEqual({
      ok: true
    })
    await expect(
      submitGiteaPRReview('/repo', 12, 'request_changes', 'Needs tests')
    ).resolves.toEqual({ ok: true })
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      event: 'APPROVED',
      body: 'LGTM'
    })
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      event: 'REQUEST_CHANGES',
      body: 'Needs tests'
    })
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://git.example.com/api/v1/repos/team/widgets/pulls/12/reviews'
    )
    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
