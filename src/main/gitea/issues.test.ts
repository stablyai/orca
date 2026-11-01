import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  requestGiteaJsonMock,
  requestGiteaJsonWithHeadersMock,
  getGiteaIssueRepoRefMock,
  resolveGiteaIssueSourceMock,
  getAuthenticatedViewerMock,
  teaExecFileAsyncMock
} = vi.hoisted(() => ({
  requestGiteaJsonMock: vi.fn(),
  requestGiteaJsonWithHeadersMock: vi.fn(),
  getGiteaIssueRepoRefMock: vi.fn(),
  resolveGiteaIssueSourceMock: vi.fn(),
  getAuthenticatedViewerMock: vi.fn(),
  teaExecFileAsyncMock: vi.fn()
}))

vi.mock('./client', () => ({
  requestGiteaJson: requestGiteaJsonMock,
  requestGiteaJsonWithHeaders: requestGiteaJsonWithHeadersMock
}))

vi.mock('./gitea-issue-source-resolution', () => ({
  getGiteaIssueRepoRef: getGiteaIssueRepoRefMock,
  resolveGiteaIssueSource: resolveGiteaIssueSourceMock
}))

vi.mock('./gitea-auth-and-rate-limit', () => ({
  getAuthenticatedViewer: getAuthenticatedViewerMock
}))

vi.mock('../git/runner', () => ({
  teaExecFileAsync: teaExecFileAsyncMock
}))

import { addGiteaIssueComment, createGiteaIssue, getGiteaIssue, listGiteaIssues } from './issues'

const repo = {
  host: 'git.example.com',
  owner: 'team',
  repo: 'widgets',
  apiBaseUrl: 'https://git.example.com/api/v1',
  webBaseUrl: 'https://git.example.com',
  loginName: 'work'
}

function rawIssue(overrides: Record<string, unknown> = {}) {
  return {
    number: 12,
    title: 'Broken widget',
    body: 'Steps to reproduce',
    state: 'open',
    html_url: 'https://git.example.com/team/widgets/issues/12',
    updated_at: '2026-05-15T00:00:00Z',
    user: { login: 'octo' },
    labels: [{ name: 'bug' }, 'ui'],
    assignees: [{ login: 'ada' }, { username: 'grace' }],
    ...overrides
  }
}

describe('getGiteaIssue', () => {
  beforeEach(() => {
    requestGiteaJsonMock.mockReset()
    getGiteaIssueRepoRefMock.mockReset()
    getGiteaIssueRepoRefMock.mockResolvedValue(repo)
  })

  it('maps a repository issue to GiteaIssueInfo', async () => {
    requestGiteaJsonMock.mockResolvedValue(rawIssue())

    await expect(getGiteaIssue('/repo', 12, 'conn-1', { wslDistro: 'Ubuntu' })).resolves.toEqual({
      number: 12,
      title: 'Broken widget',
      body: 'Steps to reproduce',
      state: 'open',
      url: 'https://git.example.com/team/widgets/issues/12',
      author: 'octo',
      labels: ['bug', 'ui'],
      assignees: ['ada', 'grace'],
      updatedAt: '2026-05-15T00:00:00Z'
    })
    expect(getGiteaIssueRepoRefMock).toHaveBeenCalledWith('/repo', 'conn-1', {
      wslDistro: 'Ubuntu'
    })
    expect(requestGiteaJsonMock).toHaveBeenCalledWith(repo, '/repos/team/widgets/issues/12', {
      allowNotFound: true
    })
  })

  it('returns null when the issue is missing', async () => {
    requestGiteaJsonMock.mockResolvedValue(null)

    await expect(getGiteaIssue('/repo', 404)).resolves.toBeNull()
  })

  it('returns null when the shared index is a pull request', async () => {
    requestGiteaJsonMock.mockResolvedValue(rawIssue({ pull_request: {} }))

    await expect(getGiteaIssue('/repo', 12)).resolves.toBeNull()
  })
})

describe('listGiteaIssues', () => {
  beforeEach(() => {
    requestGiteaJsonWithHeadersMock.mockReset()
    resolveGiteaIssueSourceMock.mockReset()
    getAuthenticatedViewerMock.mockReset()
    resolveGiteaIssueSourceMock.mockResolvedValue({ source: repo, fellBack: false })
    requestGiteaJsonWithHeadersMock.mockResolvedValue({
      data: [rawIssue(), rawIssue({ number: 8, title: 'A pull request', pull_request: {} })],
      headers: { 'x-total-count': '2' }
    })
  })

  it('lists issues with type=issues and drops pull-request rows', async () => {
    await expect(listGiteaIssues('/repo', 20, 'origin', 'opened')).resolves.toMatchObject({
      items: [{ number: 12, title: 'Broken widget', state: 'open' }],
      page: 1,
      perPage: 20,
      totalCount: 2,
      totalPages: 1
    })
    expect(requestGiteaJsonWithHeadersMock).toHaveBeenCalledWith(
      repo,
      '/repos/team/widgets/issues',
      expect.objectContaining({
        searchParams: { type: 'issues', state: 'open', page: 1, limit: 20 }
      })
    )
  })

  it('resolves assignee @me to assigned_by for the authenticated viewer', async () => {
    getAuthenticatedViewerMock.mockResolvedValue({ username: 'ada', email: null })
    requestGiteaJsonWithHeadersMock.mockResolvedValue({
      data: [],
      headers: { 'x-total-count': '0' }
    })

    await listGiteaIssues('/repo', 10, undefined, 'opened', '@me', 'conn-1')

    expect(getAuthenticatedViewerMock).toHaveBeenCalledWith('work')
    expect(requestGiteaJsonWithHeadersMock).toHaveBeenCalledWith(
      repo,
      '/repos/team/widgets/issues',
      expect.objectContaining({
        searchParams: expect.objectContaining({ type: 'issues', assigned_by: 'ada', limit: 10 })
      })
    )
  })

  it('computes totalCount and totalPages from x-total-count', async () => {
    requestGiteaJsonWithHeadersMock.mockResolvedValue({
      data: [rawIssue()],
      headers: { 'x-total-count': '41' }
    })

    await expect(
      listGiteaIssues('/repo', 20, undefined, 'closed', 'ada', null, {}, 2, '  widgets  ')
    ).resolves.toMatchObject({
      page: 2,
      perPage: 20,
      totalCount: 41,
      totalPages: 3
    })
    expect(requestGiteaJsonWithHeadersMock).toHaveBeenCalledWith(
      repo,
      '/repos/team/widgets/issues',
      expect.objectContaining({
        searchParams: {
          type: 'issues',
          state: 'closed',
          page: 2,
          limit: 20,
          assigned_by: 'ada',
          q: 'widgets'
        }
      })
    )
  })
})

const OLD_ENV = process.env

const createdComment = {
  id: 44,
  body: 'Ship the widget',
  created_at: '2026-10-29T12:00:00Z',
  html_url: 'https://git.example.com/team/widgets/issues/12#issuecomment-44',
  user: { login: 'ada', avatar_url: 'https://git.example.com/avatars/ada' }
}

describe('createGiteaIssue and addGiteaIssueComment', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    delete process.env.ORCA_GITEA_TOKEN
    delete process.env.GITEA_TOKEN
    delete process.env.ORCA_GITEA_API_BASE_URL
    delete process.env.GITEA_INSTANCE_URL
    resolveGiteaIssueSourceMock.mockReset()
    resolveGiteaIssueSourceMock.mockResolvedValue({ source: repo, fellBack: false })
    teaExecFileAsyncMock.mockReset()
    teaExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({
        index: 924,
        url: 'https://git.example.com/team/widgets/issues/924'
      }),
      stderr: ''
    })
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    process.env = OLD_ENV
    vi.unstubAllGlobals()
  })

  it('rejects an empty title before spawning tea', async () => {
    await expect(createGiteaIssue('/repo', '   ', 'body', 'origin')).resolves.toEqual({
      ok: false,
      error: 'Title is required'
    })
    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
    expect(resolveGiteaIssueSourceMock).not.toHaveBeenCalled()
  })

  it('creates an issue on the preference-selected project and returns its number and url', async () => {
    await expect(
      createGiteaIssue('/repo', '  New issue  ', 'Body', 'upstream', 'conn-1', {
        wslDistro: 'Ubuntu'
      })
    ).resolves.toEqual({
      ok: true,
      number: 924,
      url: 'https://git.example.com/team/widgets/issues/924'
    })
    expect(resolveGiteaIssueSourceMock).toHaveBeenCalledWith('/repo', 'upstream', 'conn-1', {
      wslDistro: 'Ubuntu'
    })
    expect(teaExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'issues',
        'create',
        '--repo',
        'team/widgets',
        '--login',
        'work',
        '--title',
        'New issue',
        '--description',
        'Body',
        '-o',
        'json'
      ],
      expect.objectContaining({ idempotent: false, cwd: '/repo', wslDistro: 'Ubuntu' })
    )
  })

  it('creates an issue over HTTP when a token is set and does not retry through tea', async () => {
    process.env.ORCA_GITEA_TOKEN = 'gitea-token'
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          number: 31,
          html_url: 'https://git.example.com/team/widgets/issues/31'
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } }
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(createGiteaIssue('/repo', 'New issue', 'Body', 'origin')).resolves.toEqual({
      ok: true,
      number: 31,
      url: 'https://git.example.com/team/widgets/issues/31'
    })
    expect(teaExecFileAsyncMock).not.toHaveBeenCalled()
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://git.example.com/api/v1/repos/team/widgets/issues'
    )
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: 'POST' }))
    const init = fetchMock.mock.calls[0]?.[1]
    expect(JSON.parse(String(init?.body))).toEqual({ title: 'New issue', body: 'Body' })
  })

  it('posts an issue comment with tea api on the override project', async () => {
    teaExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify(createdComment),
      stderr: ''
    })

    await expect(
      addGiteaIssueComment(
        '/repo',
        12,
        'Ship the widget',
        'origin',
        'conn-1',
        { host: 'git.example.com', path: 'fork/widgets' },
        { wslDistro: 'Ubuntu' }
      )
    ).resolves.toEqual({
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
    expect(resolveGiteaIssueSourceMock).toHaveBeenCalledWith('/repo', 'origin', 'conn-1', {
      wslDistro: 'Ubuntu'
    })
    expect(teaExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        '-X',
        'POST',
        '/repos/fork/widgets/issues/12/comments',
        '-f',
        'body=Ship the widget',
        '--repo',
        'fork/widgets',
        '--login',
        'work'
      ],
      expect.objectContaining({ idempotent: false, cwd: '/repo', wslDistro: 'Ubuntu' })
    )
  })
})
