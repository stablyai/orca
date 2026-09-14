import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))
vi.mock('../git/runner', () => moduleMocks.gitRunnerModuleMock(clientMocks))
vi.mock('../providers/ssh-git-dispatch', () => moduleMocks.sshGitDispatchModuleMock(clientMocks))
vi.mock('./local-git-config-signature', () =>
  moduleMocks.localGitConfigSignatureModuleMock(clientMocks)
)
vi.mock('./github-enterprise-repository', async (importOriginal) =>
  moduleMocks.githubEnterpriseRepositoryModuleMock(
    await importOriginal<typeof GitHubEnterpriseRepositoryModule>()
  )
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(clientMocks))
vi.mock('./github-api-repository', async (importOriginal) =>
  moduleMocks.githubApiRepositoryModuleMock(
    clientMocks,
    await importOriginal<typeof GithubApiRepositoryModule>()
  )
)

import { getPRForBranch } from './client'
import { resetPRForBranchMocks } from './client-test-harness'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  resolvePRRepositoryCandidatesMock,
  gitExecFileAsyncMock
} = clientMocks

describe('getPRForBranch', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
  })

  it('looks up a linked PR number across PR repo candidates', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [
        { owner: 'stablyai', repo: 'orca' },
        { owner: 'fork', repo: 'orca' }
      ],
      headRepo: { owner: 'fork', repo: 'orca' }
    })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'linked-head-oid\n', stderr: '' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 404: Not Found'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 99,
          title: 'Linked fork PR',
          state: 'OPEN',
          url: 'https://github.com/fork/orca/pull/99',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'feature/test',
          baseRefOid: 'base-oid',
          headRefOid: 'linked-head-oid'
        })
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test', 99)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'pr',
        'view',
        '99',
        '--repo',
        'stablyai/orca',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      [
        'pr',
        'view',
        '99',
        '--repo',
        'fork/orca',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr?.prRepo).toEqual({ owner: 'fork', repo: 'orca' })
  })

  it('prefers exact linked PR lookup when the repo identity is known', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'linked-head-oid\n', stderr: '' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 99,
        title: 'Linked PR',
        state: 'OPEN',
        url: 'https://github.com/acme/widgets/pull/99',
        statusCheckRollup: [],
        updatedAt: '2026-03-28T00:00:00Z',
        isDraft: false,
        mergeable: 'MERGEABLE',
        baseRefName: 'main',
        headRefName: 'someone/fix',
        baseRefOid: 'base-oid',
        headRefOid: 'linked-head-oid'
      })
    })

    const pr = await getPRForBranch('/repo-root', 'feature/local-worktree', 99)

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'view',
        '99',
        '--repo',
        'acme/widgets',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({
      number: 99,
      title: 'Linked PR',
      state: 'open',
      headSha: 'linked-head-oid'
    })
  })

  it('caches exact REST stack probes across linked PR refreshes', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr') {
        return {
          stdout: JSON.stringify({
            number: 99,
            title: 'Linked PR',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/pull/99',
            statusCheckRollup: [],
            updatedAt: '2026-03-28T00:00:00Z',
            isDraft: false,
            mergeable: 'MERGEABLE',
            baseRefName: 'main',
            headRefName: 'feature',
            headRefOid: 'head-oid'
          })
        }
      }
      return {
        stdout: JSON.stringify({
          number: 99,
          title: 'Linked PR',
          state: 'open',
          stack: null
        })
      }
    })

    await getPRForBranch('/repo-root', 'feature', 99)
    await getPRForBranch('/repo-root', 'feature', 99)
    await getPRForBranch('/repo-root', 'feature', 99, 'ssh-1')

    expect(
      ghExecFileAsyncMock.mock.calls.filter(
        ([args]) => args[0] === 'api' && args[1]?.includes('/99')
      )
    ).toHaveLength(2)
    expect(ghExecFileAsyncMock.mock.calls.filter(([args]) => args[0] === 'pr')).toHaveLength(3)
  })

  it('caches failed REST stack probes across linked PR refreshes', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr') {
        return {
          stdout: JSON.stringify({
            number: 99,
            title: 'Linked PR',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/pull/99',
            statusCheckRollup: [],
            updatedAt: '2026-03-28T00:00:00Z',
            isDraft: false,
            mergeable: 'MERGEABLE',
            baseRefName: 'main',
            headRefName: 'feature',
            headRefOid: 'head-oid'
          })
        }
      }
      throw new Error('GitHub is temporarily unavailable')
    })

    await getPRForBranch('/repo-root', 'feature', 99)
    await getPRForBranch('/repo-root', 'feature', 99)

    expect(
      ghExecFileAsyncMock.mock.calls.filter(
        ([args]) => args[0] === 'api' && args[1]?.includes('/99')
      )
    ).toHaveLength(1)
  })

  it('hydrates repository merge method settings for exact PR lookups', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 99,
          title: 'Linked PR',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/99',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          reviewDecision: 'APPROVED',
          mergeStateStatus: 'CLEAN',
          autoMergeRequest: null,
          baseRefName: 'main',
          headRefName: 'someone/fix',
          baseRefOid: 'base-oid',
          headRefOid: 'linked-head-oid'
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            repository: {
              viewerDefaultMergeMethod: 'REBASE',
              mergeCommitAllowed: false,
              rebaseMergeAllowed: true,
              squashMergeAllowed: true,
              autoMergeAllowed: true,
              mergeQueue: null
            }
          }
        })
      })

    const pr = await getPRForBranch('/repo-root', 'feature/local-worktree', 99)

    expect(pr?.mergeMethodSettings).toEqual({
      defaultMethod: 'rebase',
      allowedMethods: {
        squash: true,
        merge: false,
        rebase: true
      }
    })
    expect(pr?.mergeQueueRequired).toBe(false)
    expect(pr?.autoMergeAllowed).toBe(true)
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining([
        'api',
        'graphql',
        '-f',
        'owner=acme',
        '-f',
        'repo=widgets',
        '-f',
        'branch=main'
      ]),
      { cwd: '/repo-root' }
    )
  })

  it('isolates viewer-dependent merge metadata across SSH connections', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    let metadataProbe = 0
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args.includes('graphql')) {
        metadataProbe += 1
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                autoMergeAllowed: metadataProbe === 1,
                mergeQueue: null
              }
            }
          })
        }
      }
      if (args[0] === 'pr') {
        return {
          stdout: JSON.stringify({
            number: 99,
            title: 'Linked PR',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/pull/99',
            statusCheckRollup: [],
            updatedAt: '2026-03-28T00:00:00Z',
            isDraft: false,
            mergeable: 'MERGEABLE',
            reviewDecision: 'APPROVED',
            mergeStateStatus: 'CLEAN',
            autoMergeRequest: null,
            baseRefName: 'main',
            headRefName: 'feature',
            headRefOid: 'head-oid'
          })
        }
      }
      return { stdout: JSON.stringify({ number: 99, state: 'open', stack: null }) }
    })

    const firstAccount = await getPRForBranch('/repo-root', 'feature', 99, 'ssh-account-1')
    const secondAccount = await getPRForBranch('/repo-root', 'feature', 99, 'ssh-account-2')

    expect(firstAccount?.autoMergeAllowed).toBe(true)
    expect(secondAccount?.autoMergeAllowed).toBe(false)
    expect(metadataProbe).toBe(2)
  })

  it('treats linked PR metadata as authoritative even when the branch head differs', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'current-worktree-head\n', stderr: '' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 99,
          title: 'Stale linked PR',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/99',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'someone/other-work',
          baseRefOid: 'base-oid',
          headRefOid: 'stale-linked-head'
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 42,
            title: 'Branch PR',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/pull/42',
            statusCheckRollup: [],
            updatedAt: '2026-03-28T00:00:00Z',
            isDraft: false,
            mergeable: 'MERGEABLE',
            baseRefName: 'main',
            headRefName: 'feature/test',
            baseRefOid: 'base-oid',
            headRefOid: 'current-worktree-head'
          }
        ])
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test', 99)

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(pr?.number).toBe(99)
  })

  it('does not fall back to branch discovery when linked PR metadata is stale', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 404: Not Found'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 42,
            title: 'Branch PR',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/pull/42',
            statusCheckRollup: [],
            updatedAt: '2026-03-28T00:00:00Z',
            isDraft: false,
            mergeable: 'MERGEABLE',
            baseRefName: 'main',
            headRefName: 'feature/test',
            baseRefOid: 'base-oid',
            headRefOid: 'head-oid'
          }
        ])
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test', 99)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'pr',
        'view',
        '99',
        '--repo',
        'acme/widgets',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(pr).toBeNull()
  })

  it('returns no PR when linked PR REST fallback also misses', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('GraphQL: could not resolve to PullRequest'))
      .mockRejectedValueOnce(new Error('HTTP 404: Not Found'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 42,
            title: 'Branch PR after stale linked miss',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/pull/42',
            statusCheckRollup: [],
            updatedAt: '2026-03-28T00:00:00Z',
            isDraft: false,
            mergeable: 'MERGEABLE',
            baseRefName: 'main',
            headRefName: 'feature/test',
            baseRefOid: 'base-oid',
            headRefOid: 'head-oid'
          }
        ])
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test', 99)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(2, ['api', 'repos/acme/widgets/pulls/99'], {
      cwd: '/repo-root'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(pr).toBeNull()
  })

  it('returns no PR when linked PR REST fallback has an unclassified failure', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('GraphQL: server exploded'))
      .mockRejectedValueOnce(new Error('HTTP 500: server error'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 42,
            title: 'Branch PR after exact lookup outage',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/pull/42',
            statusCheckRollup: [],
            updatedAt: '2026-03-28T00:00:00Z',
            isDraft: false,
            mergeable: 'MERGEABLE',
            baseRefName: 'main',
            headRefName: 'feature/test',
            baseRefOid: 'base-oid',
            headRefOid: 'head-oid'
          }
        ])
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test', 99)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(2, ['api', 'repos/acme/widgets/pulls/99'], {
      cwd: '/repo-root'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(pr).toBeNull()
  })

  it('does not continue to branch discovery when linked PR REST fallback is rate limited', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('GraphQL: API rate limit already exceeded'))
      .mockRejectedValueOnce(new Error('REST API rate limit already exceeded'))

    const pr = await getPRForBranch('/repo-root', 'feature/test', 99)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'pr',
        'view',
        '99',
        '--repo',
        'acme/widgets',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(2, ['api', 'repos/acme/widgets/pulls/99'], {
      cwd: '/repo-root'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(pr).toBeNull()
  })

  it('uses linked PR number as the source of truth when provided', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 77,
        title: 'Linked PR lookup',
        state: 'OPEN',
        url: 'https://github.com/acme/widgets/pull/77',
        statusCheckRollup: [],
        updatedAt: '2026-03-28T00:00:00Z',
        isDraft: false,
        mergeable: 'MERGEABLE',
        baseRefName: 'main',
        headRefName: 'contributor/original',
        baseRefOid: 'base-oid',
        headRefOid: 'head-oid'
      })
    })

    const pr = await getPRForBranch('/repo-root', 'refs/heads/local-created-from-pr', 77)

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'view',
        '77',
        '--repo',
        'acme/widgets',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr?.number).toBe(77)
  })

  it('normalizes exact linked PR fallback metadata when no GitHub remote is resolved', async () => {
    getOwnerRepoMock.mockResolvedValueOnce(null)
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 77,
        title: 'Linked fallback PR',
        state: 'OPEN',
        url: 'https://example.com/pr/77',
        statusCheckRollup: [],
        updatedAt: '2026-03-28T00:00:00Z',
        isDraft: false,
        mergeable: 'MERGEABLE',
        reviewDecision: '',
        autoMergeRequest: { enabledAt: '2026-03-28T00:00:00Z' },
        baseRefName: 'main',
        headRefName: 'feature/test',
        baseRefOid: 'base-oid',
        headRefOid: 'head-oid'
      })
    })

    const pr = await getPRForBranch('/non-github-repo', 'feature/test', 77)

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'view',
        '77',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/non-github-repo' }
    )
    expect(pr).toMatchObject({
      number: 77,
      reviewDecision: null,
      autoMergeEnabled: true
    })
    expect(pr?.mergeQueueRequired).toBeUndefined()
  })

  it('falls back to gh pr view when the remote cannot be resolved to GitHub', async () => {
    getOwnerRepoMock.mockResolvedValueOnce(null)
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 7,
        title: 'Fallback lookup',
        state: 'OPEN',
        url: 'https://example.com/pr/7',
        statusCheckRollup: [],
        updatedAt: '2026-03-28T00:00:00Z',
        isDraft: true,
        mergeable: 'CONFLICTING',
        baseRefName: 'main',
        headRefName: 'feature/test',
        baseRefOid: 'base-oid',
        headRefOid: 'head-oid'
      })
    })

    const pr = await getPRForBranch('/non-github-repo', 'feature/test')

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'view',
        'feature/test',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/non-github-repo' }
    )
    expect(pr?.number).toBe(7)
    expect(pr?.state).toBe('draft')
    expect(pr?.mergeable).toBe('CONFLICTING')
  })

  it('falls back to REST number lookup when linked PR GraphQL lookup is rate limited', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'linked-head-oid\n', stderr: '' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('GraphQL: API rate limit already exceeded'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 99,
          title: 'REST linked PR lookup',
          state: 'closed',
          merged_at: '2026-03-28T00:00:00Z',
          html_url: 'https://github.com/acme/widgets/pull/99',
          updated_at: '2026-03-28T00:00:00Z',
          draft: false,
          mergeable_state: 'clean',
          head: { ref: 'someone/fix', sha: 'linked-head-oid' },
          base: { ref: 'main', sha: 'linked-base-oid' }
        })
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test', 99)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'pr',
        'view',
        '99',
        '--repo',
        'acme/widgets',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(2, ['api', 'repos/acme/widgets/pulls/99'], {
      cwd: '/repo-root'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(pr).toMatchObject({
      number: 99,
      state: 'merged',
      mergeable: 'MERGEABLE',
      headSha: 'linked-head-oid'
    })
  })
})
