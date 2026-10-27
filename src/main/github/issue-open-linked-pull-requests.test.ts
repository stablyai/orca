import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GithubEnterpriseRepositoryModule from './github-enterprise-repository'
import type * as GhUtils from './gh-utils'

const { ghExecFileAsyncMock, getIssueOwnerRepoMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getIssueOwnerRepoMock: vi.fn()
}))

vi.mock('./gh-utils', async () => {
  const actual = await vi.importActual<typeof GhUtils>('./gh-utils')
  return {
    ...actual,
    ghExecFileAsync: ghExecFileAsyncMock,
    acquire: vi.fn().mockResolvedValue(undefined),
    release: vi.fn()
  }
})

vi.mock('./github-enterprise-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof GithubEnterpriseRepositoryModule>()),
  isGitHubHostAuthenticated: vi.fn().mockResolvedValue(true)
}))

vi.mock('./github-api-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof GithubApiRepositoryModule>()
  return {
    ...actual,
    getIssueGitHubApiRepository: async () => ({
      host: 'github.com' as const,
      ...(await getIssueOwnerRepoMock())
    })
  }
})

import { getIssue } from './issues'
import { _resetOriginGitHubApiRepositoryCache } from './github-api-repository'

const ISSUE = {
  number: 28343,
  title: 'Clicking host menu items toggles the host accordion',
  state: 'open',
  html_url: 'https://github.com/stablyai/orca/issues/28343',
  labels: [],
  body: ''
}

function pullRequest(
  number: number,
  state: 'OPEN' | 'CLOSED' | 'MERGED',
  author: string,
  createdAt: string
) {
  return {
    __typename: 'PullRequest',
    number,
    title: `PR ${number}`,
    url: `https://github.com/stablyai/orca/pull/${number}`,
    state,
    createdAt,
    headRefName: `branch-${number}`,
    author: { login: author }
  }
}

function timelineResponse(nodes: unknown[]) {
  return {
    stdout: JSON.stringify({
      data: { repository: { issue: { timelineItems: { nodes } } } }
    })
  }
}

describe('getIssue open linked pull requests', () => {
  beforeEach(() => {
    _resetOriginGitHubApiRepositoryCache()
    ghExecFileAsyncMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    getIssueOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
  })

  it('lists the open pull requests that reference the issue, newest first', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify(ISSUE) })
      .mockResolvedValueOnce(
        timelineResponse([
          {
            __typename: 'CrossReferencedEvent',
            source: pullRequest(28395, 'OPEN', 'lesbass', '2026-10-13T20:01:09Z')
          },
          {
            __typename: 'CrossReferencedEvent',
            source: pullRequest(28100, 'CLOSED', 'someone', '2026-10-12T08:00:00Z')
          },
          {
            __typename: 'CrossReferencedEvent',
            source: { __typename: 'Issue', number: 4912 }
          },
          {
            __typename: 'ConnectedEvent',
            subject: pullRequest(28628, 'OPEN', 'lesbass', '2026-10-14T07:00:00Z')
          },
          {
            __typename: 'CrossReferencedEvent',
            source: pullRequest(28395, 'OPEN', 'lesbass', '2026-10-13T20:01:09Z')
          }
        ])
      )

    const issue = await getIssue('/repo-root', 28343)

    expect(issue?.openLinkedPullRequests).toEqual([
      {
        number: 28628,
        title: 'PR 28628',
        url: 'https://github.com/stablyai/orca/pull/28628',
        author: 'lesbass',
        headRefName: 'branch-28628',
        createdAt: '2026-10-14T07:00:00Z'
      },
      {
        number: 28395,
        title: 'PR 28395',
        url: 'https://github.com/stablyai/orca/pull/28395',
        author: 'lesbass',
        headRefName: 'branch-28395',
        createdAt: '2026-10-13T20:01:09Z'
      }
    ])
  })
})
