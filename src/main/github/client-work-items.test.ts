import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  execFileAsyncMock,
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  gitExecFileAsyncMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  execFileAsync: execFileAsyncMock,
  ghExecFileAsync: ghExecFileAsyncMock,
  getOwnerRepo: getOwnerRepoMock,
  acquire: acquireMock,
  release: releaseMock,
  _resetOwnerRepoCache: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { listWorkItems, _resetOwnerRepoCache } from './client'

describe('listWorkItems', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    _resetOwnerRepoCache()
  })

  it('runs both issue and PR GitHub searches for a mixed query and merges the results by recency', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 12,
            title: 'Fix bug',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/issues/12',
            labels: [],
            updatedAt: '2026-03-29T00:00:00Z',
            author: { login: 'octocat' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 42,
            title: 'Add feature',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/pull/42',
            labels: [],
            updatedAt: '2026-03-28T00:00:00Z',
            author: { login: 'octocat' },
            isDraft: false,
            headRefName: 'feature/add-feature',
            baseRefName: 'main'
          }
        ])
      })
    const items = await listWorkItems('/repo-root', 10, 'assignee:@me')
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'issue',
        'list',
        '--limit',
        '10',
        '--json',
        'number,title,state,url,labels,updatedAt,author',
        '--repo',
        'acme/widgets',
        '--assignee',
        '@me'
      ],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      [
        'pr',
        'list',
        '--limit',
        '10',
        '--json',
        'number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRepositoryOwner',
        '--repo',
        'acme/widgets',
        '--assignee',
        '@me'
      ],
      { cwd: '/repo-root' }
    )
    expect(items).toEqual([
      {
        id: 'issue:12',
        type: 'issue',
        number: 12,
        title: 'Fix bug',
        state: 'open',
        url: 'https://github.com/acme/widgets/issues/12',
        labels: [],
        updatedAt: '2026-03-29T00:00:00Z',
        author: 'octocat'
      },
      {
        id: 'pr:42',
        type: 'pr',
        number: 42,
        title: 'Add feature',
        state: 'open',
        url: 'https://github.com/acme/widgets/pull/42',
        labels: [],
        updatedAt: '2026-03-28T00:00:00Z',
        author: 'octocat',
        branchName: 'feature/add-feature',
        baseRefName: 'main'
      }
    ])
  })

  it('routes draft queries to PR search only', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 7,
          title: 'Draft work',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/7',
          labels: [],
          updatedAt: '2026-03-30T00:00:00Z',
          author: { login: 'octocat' },
          isDraft: true,
          headRefName: 'draft/work',
          baseRefName: 'main'
        }
      ])
    })
    const items = await listWorkItems('/repo-root', 10, 'is:pr is:draft')
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'list',
        '--limit',
        '10',
        '--json',
        'number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRepositoryOwner',
        '--repo',
        'acme/widgets',
        '--state',
        'open',
        '--draft'
      ],
      { cwd: '/repo-root' }
    )
    expect(items).toEqual([
      {
        id: 'pr:7',
        type: 'pr',
        number: 7,
        title: 'Draft work',
        state: 'draft',
        url: 'https://github.com/acme/widgets/pull/7',
        labels: [],
        updatedAt: '2026-03-30T00:00:00Z',
        author: 'octocat',
        branchName: 'draft/work',
        baseRefName: 'main'
      }
    ])
  })

  it('passes review-requested as a --search qualifier (gh CLI has no dedicated flag)', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    await listWorkItems('/repo-root', 10, 'review-requested:@me is:open')

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      expect.arrayContaining(['--search', 'review-requested:@me']),
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(['--review-requested']),
      expect.anything()
    )
  })

  it('returns open issues and PRs for the all-open preset query', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 1,
            title: 'Open issue',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/issues/1',
            labels: [],
            updatedAt: '2026-03-31T00:00:00Z',
            author: { login: 'octocat' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 2,
            title: 'Open PR',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/pull/2',
            labels: [],
            updatedAt: '2026-03-30T00:00:00Z',
            author: { login: 'octocat' },
            isDraft: false,
            headRefName: 'feature/open-pr',
            baseRefName: 'main'
          }
        ])
      })
    const items = await listWorkItems('/repo-root', 10, 'is:open')
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'issue',
        'list',
        '--limit',
        '10',
        '--json',
        'number,title,state,url,labels,updatedAt,author',
        '--repo',
        'acme/widgets',
        '--state',
        'open'
      ],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'list',
        '--limit',
        '10',
        '--json',
        'number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRepositoryOwner',
        '--repo',
        'acme/widgets',
        '--state',
        'open'
      ],
      { cwd: '/repo-root' }
    )
    expect(items).toEqual([
      {
        id: 'issue:1',
        type: 'issue',
        number: 1,
        title: 'Open issue',
        state: 'open',
        url: 'https://github.com/acme/widgets/issues/1',
        labels: [],
        updatedAt: '2026-03-31T00:00:00Z',
        author: 'octocat'
      },
      {
        id: 'pr:2',
        type: 'pr',
        number: 2,
        title: 'Open PR',
        state: 'open',
        url: 'https://github.com/acme/widgets/pull/2',
        labels: [],
        updatedAt: '2026-03-30T00:00:00Z',
        author: 'octocat',
        branchName: 'feature/open-pr',
        baseRefName: 'main'
      }
    ])
  })
})
