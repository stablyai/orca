import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  requestGiteaJsonMock,
  requestGiteaTextMock,
  resolveGiteaIssueSourceMock,
  getTeaKnownLoginsMock,
  fetchGiteaPipelineJobsMock
} = vi.hoisted(() => ({
  requestGiteaJsonMock: vi.fn(),
  requestGiteaTextMock: vi.fn(),
  resolveGiteaIssueSourceMock: vi.fn(),
  getTeaKnownLoginsMock: vi.fn(),
  fetchGiteaPipelineJobsMock: vi.fn()
}))

vi.mock('./client', () => ({
  requestGiteaJson: requestGiteaJsonMock,
  requestGiteaText: requestGiteaTextMock
}))

vi.mock('./gitea-issue-source-resolution', () => ({
  resolveGiteaIssueSource: resolveGiteaIssueSourceMock
}))

vi.mock('./gitea-known-host-probe', () => ({
  getTeaKnownLogins: getTeaKnownLoginsMock
}))

vi.mock('./actions-job-graph', () => ({
  fetchGiteaPipelineJobs: fetchGiteaPipelineJobsMock
}))

import { getGiteaWorkItemDetails } from './work-item-details'

const repo = {
  host: 'git.example.com',
  owner: 'team',
  repo: 'widgets',
  apiBaseUrl: 'https://git.example.com/api/v1',
  webBaseUrl: 'https://git.example.com',
  loginName: 'work'
}

function user(id: number, login: string, avatar = '') {
  return { id, login, avatar_url: avatar }
}

const reviews = [
  {
    id: 1,
    body: '',
    html_url: 'https://git.example.com/team/widgets/pulls/8#pullreview-1',
    submitted_at: '2026-05-01T00:00:00Z',
    state: 'COMMENT',
    user: user(1, 'alice', 'https://example.com/alice.png')
  },
  {
    id: 2,
    body: 'LGTM',
    html_url: 'https://git.example.com/team/widgets/pulls/8#pullreview-2',
    submitted_at: '2026-05-02T00:00:00Z',
    state: 'APPROVED',
    user: user(1, 'alice', 'https://example.com/alice.png')
  },
  {
    id: 3,
    body: '',
    html_url: 'https://git.example.com/team/widgets/pulls/8#pullreview-3',
    submitted_at: '2026-05-01T00:00:00Z',
    state: 'APPROVED',
    user: user(2, 'bob', 'https://example.com/bob.png')
  },
  {
    id: 4,
    body: 'fix this',
    html_url: 'https://git.example.com/team/widgets/pulls/8#pullreview-4',
    submitted_at: '2026-05-03T00:00:00Z',
    state: 'REQUEST_CHANGES',
    user: user(2, 'bob', 'https://example.com/bob.png')
  },
  {
    id: 5,
    body: '',
    html_url: 'https://git.example.com/team/widgets/pulls/8#pullreview-5',
    submitted_at: '2026-05-01T00:00:00Z',
    state: 'REQUEST_CHANGES',
    user: user(3, 'cara')
  },
  {
    id: 6,
    body: '',
    html_url: 'https://git.example.com/team/widgets/pulls/8#pullreview-6',
    submitted_at: '2026-05-04T00:00:00Z',
    state: 'APPROVED',
    user: user(3, 'cara')
  },
  {
    id: 7,
    body: '',
    html_url: 'https://git.example.com/team/widgets/pulls/8#pullreview-7',
    submitted_at: '2026-05-01T00:00:00Z',
    state: 'APPROVED',
    user: user(5, 'eve')
  },
  {
    id: 8,
    body: '',
    html_url: 'https://git.example.com/team/widgets/pulls/8#pullreview-8',
    submitted_at: '2026-05-05T00:00:00Z',
    state: 'DISMISSED',
    dismissed: true,
    user: user(5, 'eve')
  }
]

describe('getGiteaWorkItemDetails', () => {
  beforeEach(() => {
    requestGiteaJsonMock.mockReset()
    requestGiteaTextMock.mockReset()
    resolveGiteaIssueSourceMock.mockReset()
    getTeaKnownLoginsMock.mockReset()
    resolveGiteaIssueSourceMock.mockResolvedValue({ source: repo, fellBack: false })
    getTeaKnownLoginsMock.mockResolvedValue([])
    requestGiteaTextMock.mockResolvedValue('')
    fetchGiteaPipelineJobsMock.mockReset()
    fetchGiteaPipelineJobsMock.mockResolvedValue([])
  })

  it('assembles issue body, assignees, and timeline comments', async () => {
    requestGiteaJsonMock.mockImplementation(async (_repo: unknown, path: string) => {
      if (path === '/repos/team/widgets/issues/7') {
        return {
          number: 7,
          title: 'Broken widget',
          body: 'Steps to reproduce',
          state: 'open',
          html_url: 'https://git.example.com/team/widgets/issues/7',
          updated_at: '2026-05-02T00:00:00Z',
          user: { login: 'octo' },
          labels: [{ name: 'bug' }],
          assignees: [{ login: 'erin' }, { username: 'frank' }]
        }
      }
      if (path === '/repos/team/widgets/issues/7/comments') {
        return [
          {
            id: 2,
            body: 'second',
            html_url: 'https://git.example.com/team/widgets/issues/7#issuecomment-2',
            created_at: '2026-05-02T00:00:00Z',
            user: { login: 'erin', avatar_url: 'https://example.com/erin.png' }
          },
          {
            id: 1,
            body: 'first',
            html_url: 'https://git.example.com/team/widgets/issues/7#issuecomment-1',
            created_at: '2026-05-01T00:00:00Z',
            user: { login: 'octo' }
          }
        ]
      }
      throw new Error(`unexpected Gitea path: ${path}`)
    })

    const details = await getGiteaWorkItemDetails('/repo', 7, 'issue', 'upstream', 'conn')

    expect(resolveGiteaIssueSourceMock).toHaveBeenCalledWith('/repo', 'upstream', 'conn', {})
    expect(details).toEqual({
      item: {
        id: 'gitea-issue-team/widgets-7',
        type: 'issue',
        number: 7,
        title: 'Broken widget',
        state: 'open',
        url: 'https://git.example.com/team/widgets/issues/7',
        labels: ['bug'],
        updatedAt: '2026-05-02T00:00:00Z',
        author: 'octo'
      },
      body: 'Steps to reproduce',
      assignees: ['erin', 'frank'],
      comments: [
        {
          id: 1,
          author: 'octo',
          authorAvatarUrl: '',
          body: 'first',
          createdAt: '2026-05-01T00:00:00Z',
          url: 'https://git.example.com/team/widgets/issues/7#issuecomment-1',
          isBot: false
        },
        {
          id: 2,
          author: 'erin',
          authorAvatarUrl: 'https://example.com/erin.png',
          body: 'second',
          createdAt: '2026-05-02T00:00:00Z',
          url: 'https://git.example.com/team/widgets/issues/7#issuecomment-2',
          isBot: false
        }
      ]
    })
    expect(fetchGiteaPipelineJobsMock).not.toHaveBeenCalled()
  })

  it('deduplicates PR reviews by latest submission and loads files on the full path', async () => {
    requestGiteaJsonMock.mockImplementation(async (_repo: unknown, path: string) => {
      if (path === '/repos/team/widgets/pulls/8') {
        return {
          number: 8,
          title: 'Add widget',
          state: 'open',
          html_url: 'https://git.example.com/team/widgets/pulls/8',
          updated_at: '2026-05-05T00:00:00Z',
          body: 'PR body',
          user: { login: 'octo' },
          labels: ['feature'],
          mergeable: true,
          head: {
            ref: 'feature',
            sha: 'head-sha',
            repo: { full_name: 'team/widgets' }
          },
          base: {
            ref: 'main',
            sha: 'base-sha',
            repo: { full_name: 'team/widgets' }
          },
          requested_reviewers: [
            {
              id: 4,
              login: 'dave',
              full_name: 'Dave',
              avatar_url: 'https://example.com/dave.png'
            }
          ]
        }
      }
      if (path === '/repos/team/widgets/issues/8/comments') {
        return [
          {
            id: 30,
            body: 'general comment',
            html_url: 'https://git.example.com/team/widgets/issues/8#issuecomment-30',
            created_at: '2026-05-03T12:00:00Z',
            user: { username: 'erin' }
          }
        ]
      }
      if (path === '/repos/team/widgets/pulls/8/reviews') {
        return reviews
      }
      if (path === '/repos/team/widgets/pulls/8/reviews/4/comments') {
        return [
          {
            id: 50,
            body: 'inline',
            html_url: 'https://git.example.com/team/widgets/pulls/8#issuecomment-50',
            created_at: '2026-05-03T01:00:00Z',
            path: 'src/app.ts',
            position: 12,
            resolver: { login: 'mod' },
            user: user(2, 'bob', 'https://example.com/bob.png')
          }
        ]
      }
      if (path.includes('/reviews/') && path.endsWith('/comments')) {
        return []
      }
      if (path === '/repos/team/widgets/pulls/8/files') {
        return [
          {
            filename: 'src/app.ts',
            status: 'modified',
            additions: 1,
            deletions: 1,
            patch: '@@ -1 +1 @@\n-old\n+new\n'
          }
        ]
      }
      throw new Error(`unexpected Gitea path: ${path}`)
    })

    const details = await getGiteaWorkItemDetails('/repo', 8, 'pr')

    expect(details?.item).toMatchObject({
      id: 'gitea-pr-team/widgets-8',
      type: 'pr',
      number: 8,
      title: 'Add widget',
      state: 'open',
      headSha: 'head-sha',
      branchName: 'feature',
      baseRefName: 'main',
      isCrossRepository: false
    })
    expect(details?.body).toBe('PR body')
    expect(details?.headSha).toBe('head-sha')
    expect(details?.baseSha).toBe('base-sha')
    expect(details?.comments.map((comment) => comment.id)).toEqual([2, 4, 50, 30])
    expect(details?.comments[2]).toMatchObject({
      threadId: '50',
      isResolved: true,
      path: 'src/app.ts',
      line: 12
    })
    expect(details?.files).toEqual([
      {
        path: 'src/app.ts',
        status: 'modified',
        additions: 1,
        deletions: 1,
        isBinary: false,
        diff: '@@ -1 +1 @@\n-old\n+new\n'
      }
    ])
    expect(details?.reviewers).toEqual([
      { id: 4, username: 'dave', name: 'Dave', avatarUrl: 'https://example.com/dave.png' },
      { id: 1, username: 'alice', name: null, avatarUrl: 'https://example.com/alice.png' },
      { id: 2, username: 'bob', name: null, avatarUrl: 'https://example.com/bob.png' },
      { id: 3, username: 'cara', name: null, avatarUrl: '' },
      { id: 5, username: 'eve', name: null, avatarUrl: '' }
    ])
    expect(details?.approvalState).toEqual({
      approvedBy: [
        { id: 1, username: 'alice', name: null, avatarUrl: 'https://example.com/alice.png' },
        { id: 3, username: 'cara', name: null, avatarUrl: '' }
      ],
      changesRequested: true
    })

    requestGiteaJsonMock.mockClear()
    requestGiteaTextMock.mockClear()
    const fast = await getGiteaWorkItemDetails(
      '/repo',
      8,
      'pr',
      undefined,
      undefined,
      null,
      {},
      {
        includeReviewDetails: false
      }
    )
    const paths = requestGiteaJsonMock.mock.calls.map((call) => call[1])
    expect(paths).toContain('/repos/team/widgets/pulls/8')
    expect(paths).toContain('/repos/team/widgets/issues/8/comments')
    expect(paths).not.toContain('/repos/team/widgets/pulls/8/reviews')
    expect(paths).not.toContain('/repos/team/widgets/pulls/8/files')
    expect(requestGiteaTextMock).not.toHaveBeenCalled()
    expect(fast?.comments.map((comment) => comment.body)).toEqual(['general comment'])
    expect(fast?.files).toEqual([])
    expect(fast?.reviewers).toEqual([])
    expect(fast?.approvalState).toBeUndefined()
    expect(fast?.headSha).toBe('head-sha')
    expect(details?.pipelineJobs).toEqual([])
    expect(fast?.pipelineJobs).toEqual([])
    expect(fetchGiteaPipelineJobsMock).toHaveBeenCalledWith(repo, 'head-sha', undefined, {})
  })

  it('attaches Actions jobs for the pull request head', async () => {
    const pipelineJobs = [
      {
        id: 41,
        runId: 9,
        name: 'test',
        stage: 'CI',
        status: 'success',
        webUrl: 'https://git.example.com/team/widgets/actions/runs/9/jobs/41',
        duration: 90
      }
    ]
    fetchGiteaPipelineJobsMock.mockResolvedValue(pipelineJobs)
    requestGiteaJsonMock.mockImplementation(async (_repo: unknown, path: string) => {
      if (path === '/repos/team/widgets/pulls/8') {
        return {
          number: 8,
          title: 'Add widget',
          state: 'open',
          html_url: 'https://git.example.com/team/widgets/pulls/8',
          updated_at: '2026-05-05T00:00:00Z',
          user: { login: 'octo' },
          head: { ref: 'feature', sha: 'head-sha', repo: { full_name: 'team/widgets' } },
          base: { ref: 'main', sha: 'base-sha', repo: { full_name: 'team/widgets' } }
        }
      }
      if (path === '/repos/team/widgets/issues/8/comments') {
        return []
      }
      throw new Error(`unexpected Gitea path: ${path}`)
    })

    const details = await getGiteaWorkItemDetails(
      '/repo',
      8,
      'pr',
      undefined,
      'conn-1',
      null,
      {},
      {
        includeReviewDetails: false
      }
    )

    expect(details?.pipelineJobs).toEqual(pipelineJobs)
    expect(fetchGiteaPipelineJobsMock).toHaveBeenCalledWith(repo, 'head-sha', 'conn-1', {})
  })

  it('returns null when the repository cannot be resolved', async () => {
    resolveGiteaIssueSourceMock.mockResolvedValue({ source: null, fellBack: false })

    const details = await getGiteaWorkItemDetails('/repo', 7, 'issue')

    expect(details).toBeNull()
    expect(requestGiteaJsonMock).not.toHaveBeenCalled()
  })

  it('uses an explicit project ref instead of the workspace remote', async () => {
    requestGiteaJsonMock.mockImplementation(async (_repo: unknown, path: string) => {
      if (path === '/repos/acme/widgets/issues/3') {
        return {
          number: 3,
          title: 'Elsewhere',
          body: '',
          state: 'closed',
          html_url: 'https://code.example.com/acme/widgets/issues/3',
          updated_at: '2026-05-01T00:00:00Z',
          user: { login: 'octo' }
        }
      }
      if (path === '/repos/acme/widgets/issues/3/comments') {
        return []
      }
      throw new Error(`unexpected Gitea path: ${path}`)
    })

    const details = await getGiteaWorkItemDetails('/repo', 3, 'issue', 'origin', null, {
      host: 'code.example.com',
      path: 'acme/widgets'
    })

    expect(resolveGiteaIssueSourceMock).not.toHaveBeenCalled()
    expect(details?.item).toMatchObject({
      id: 'gitea-issue-acme/widgets-3',
      number: 3,
      state: 'closed'
    })
    expect(requestGiteaJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'code.example.com', owner: 'acme', repo: 'widgets' }),
      '/repos/acme/widgets/issues/3',
      { allowNotFound: true }
    )
  })
})
