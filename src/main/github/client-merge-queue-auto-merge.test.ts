import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

import {
  getPRForBranch,
  getWorkItemByOwnerRepo,
  mergePR,
  resolveReviewThread,
  setPRAutoMerge,
  updatePRTitle,
  _getMergeQueueCacheSizeForTests
} from './client'
import { resetGraphQLRateLimitGuardMocks } from './client-test-harness'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  resolvePRRepositoryCandidatesMock,
  gitExecFileAsyncMock,
  rateLimitGuardMock,
  noteRateLimitSpendMock,
  acquireMock
} = clientMocks

describe('GitHub GraphQL rate-limit guard', () => {
  beforeEach(() => {
    resetGraphQLRateLimitGuardMocks(clientMocks)
  })

  afterEach(() => vi.restoreAllMocks())

  it('uses explicit PR repo for merge and title mutations', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 7,
          title: 'PR',
          state: 'open',
          head: { ref: 'feature', sha: 'head-oid' },
          base: { ref: 'main', sha: 'base-oid' },
          stack: null
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 7,
          title: 'PR',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/7',
          statusCheckRollup: [],
          updatedAt: '2026-04-01T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        })
      })
      .mockResolvedValue({ stdout: '', stderr: '' })

    await expect(
      mergePR('/repo-root', 7, 'squash', undefined, {
        owner: 'stablyai',
        repo: 'orca',
        host: 'github.com'
      })
    ).resolves.toEqual({ ok: true })
    await expect(
      updatePRTitle('/repo-root', 7, 'New title', undefined, {
        owner: 'stablyai',
        repo: 'orca',
        host: 'github.com'
      })
    ).resolves.toBe(true)

    expect(getOwnerRepoMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(1, ['api', 'repos/stablyai/orca/pulls/7'], {
      cwd: '/repo-root',
      host: 'github.com'
    })
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      [
        'pr',
        'view',
        '7',
        '--repo',
        'stablyai/orca',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['pr', 'merge', '7', '--squash', '--repo', 'stablyai/orca'],
      expect.objectContaining({
        cwd: '/repo-root',
        env: expect.objectContaining({ GH_PROMPT_DISABLED: '1' }),
        host: 'github.com'
      })
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      4,
      ['pr', 'edit', '7', '--title', 'New title', '--repo', 'stablyai/orca'],
      { cwd: '/repo-root', host: 'github.com' }
    )
  })

  it('sets and disables PR auto-merge with explicit PR repos and SSH context', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify({ stack: null }) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ id: 'PR_kwDO123', headRefOid: 'head-oid' })
      })
      .mockResolvedValue({ stdout: '', stderr: '' })

    await expect(
      setPRAutoMerge('/remote/repo-root', 7, true, 'squash', 'ssh-1', {
        owner: 'stablyai',
        repo: 'orca',
        host: 'github.com'
      })
    ).resolves.toEqual({ ok: true })
    await expect(
      setPRAutoMerge('/remote/repo-root', 7, false, 'squash', 'ssh-1', {
        owner: 'stablyai',
        repo: 'orca',
        host: 'github.com'
      })
    ).resolves.toEqual({ ok: true })

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(1, ['api', 'repos/stablyai/orca/pulls/7'], {
      host: 'github.com'
    })
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['pr', 'view', '7', '--json', 'id,headRefOid,baseRefName', '--repo', 'stablyai/orca'],
      { host: 'github.com' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      expect.arrayContaining([
        'api',
        'graphql',
        '-f',
        'pullRequestId=PR_kwDO123',
        '-f',
        'mergeMethod=SQUASH',
        '-f',
        'expectedHeadOid=head-oid'
      ]),
      expect.objectContaining({
        env: expect.objectContaining({ GH_PROMPT_DISABLED: '1' }),
        host: 'github.com'
      })
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      4,
      ['pr', 'merge', '7', '--disable-auto', '--repo', 'stablyai/orca'],
      expect.objectContaining({
        env: expect.objectContaining({ GH_PROMPT_DISABLED: '1' }),
        host: 'github.com'
      })
    )
    expect(ghExecFileAsyncMock.mock.calls[0]?.[1]).not.toHaveProperty('cwd')
  })

  it('enables auto-merge without invoking the direct merge command', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify({ stack: null }) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ id: 'PR_kwDO123', headRefOid: 'head-oid' })
      })
      .mockResolvedValue({ stdout: '', stderr: '' })

    await expect(
      setPRAutoMerge('/repo-root', 7, true, 'squash', undefined, {
        owner: 'stablyai',
        repo: 'orca',
        host: 'github.com'
      })
    ).resolves.toEqual({ ok: true })

    expect(
      ghExecFileAsyncMock.mock.calls.some((call) =>
        (call[0] as string[]).some((arg) => arg.includes('enablePullRequestAutoMerge'))
      )
    ).toBe(true)
    expect(
      ghExecFileAsyncMock.mock.calls.some(
        (call) =>
          call[0][0] === 'pr' && call[0][1] === 'merge' && (call[0] as string[]).includes('--auto')
      )
    ).toBe(false)
  })

  it('rejects auto-merge for GitHub-registered stacks', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 202,
        title: 'Stack API',
        state: 'open',
        head: { ref: 'stack/api', sha: 'head-oid' },
        base: { ref: 'stack/models', sha: 'models-sha' },
        stack: {
          number: 51,
          position: 2,
          size: 2,
          base: { ref: 'main', sha: 'main-sha' }
        }
      })
    })

    await expect(
      setPRAutoMerge('/repo-root', 202, true, 'squash', undefined, {
        owner: 'stablyai',
        repo: 'orca',
        host: 'github.com'
      })
    ).resolves.toEqual({
      ok: false,
      error: 'GitHub does not support auto-merge for stacked pull requests.'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('translates the GitHub clean-status rejection into an actionable message', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify({ stack: null }) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ id: 'PR_kwDO123', headRefOid: 'head-oid' })
      })
      .mockRejectedValueOnce(new Error('GraphQL: Pull request is in clean status'))

    await expect(
      setPRAutoMerge('/repo-root', 7, true, 'squash', undefined, {
        owner: 'stablyai',
        repo: 'orca',
        host: 'github.com'
      })
    ).resolves.toEqual({
      ok: false,
      error: 'This pull request can already be merged. Use Merge instead of auto-merge.'
    })
  })

  it('uses the queue-aware gh merge path when the base branch has a merge queue', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify({ stack: null }) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ id: 'PR_kwDO123', headRefOid: 'head-oid', baseRefName: 'main' })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ data: { repository: { mergeQueue: { id: 'MQ_kw' } } } })
      })
      .mockResolvedValue({ stdout: '', stderr: '' })

    await expect(
      setPRAutoMerge('/repo-root', 7, true, 'squash', undefined, {
        owner: 'stablyai',
        repo: 'orca',
        host: 'github.com'
      })
    ).resolves.toEqual({ ok: true })

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      expect.arrayContaining(['api', 'graphql', '-f', 'branch=main']),
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      4,
      ['pr', 'merge', '7', '--auto', '--squash', '--repo', 'stablyai/orca'],
      expect.objectContaining({
        cwd: '/repo-root',
        env: expect.objectContaining({ GH_PROMPT_DISABLED: '1' }),
        host: 'github.com'
      })
    )
    expect(
      ghExecFileAsyncMock.mock.calls.some((call) =>
        (call[0] as string[]).some((arg) => arg.includes('enablePullRequestAutoMerge'))
      )
    ).toBe(false)
  })

  it('blocks direct merge when GitHub reports required approval', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify({ stack: null }) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 7,
          title: 'PR',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/7',
          statusCheckRollup: [],
          updatedAt: '2026-04-01T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          reviewDecision: 'REVIEW_REQUIRED',
          mergeStateStatus: 'CLEAN',
          autoMergeRequest: null,
          baseRefName: 'main',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        })
      })

    await expect(
      mergePR('/repo-root', 7, 'squash', undefined, {
        owner: 'stablyai',
        repo: 'orca',
        host: 'github.com'
      })
    ).resolves.toEqual({
      ok: false,
      error: 'This pull request requires review approval before it can be merged.'
    })

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(3)
    expect(ghExecFileAsyncMock.mock.calls[2]?.[0]).toContain('graphql')
  })

  it('detects merge queues once per base branch and blocks direct merges', async () => {
    const prView = {
      number: 7,
      title: 'PR',
      state: 'OPEN',
      url: 'https://github.com/stablyai/orca/pull/7',
      statusCheckRollup: [],
      updatedAt: '2026-04-01T00:00:00Z',
      isDraft: false,
      mergeable: 'MERGEABLE',
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'CLEAN',
      autoMergeRequest: null,
      baseRefName: 'true',
      baseRefOid: 'base-oid',
      headRefOid: 'head-oid'
    }
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify({ stack: null }) })
      .mockResolvedValueOnce({ stdout: JSON.stringify(prView) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ data: { repository: { mergeQueue: { id: 'MQ_kw' } } } })
      })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ stack: null }) })
      .mockResolvedValueOnce({ stdout: JSON.stringify(prView) })

    await expect(
      mergePR('/repo-root', 7, 'squash', undefined, {
        owner: 'stablyai',
        repo: 'orca',
        host: 'github.com'
      })
    ).resolves.toEqual({
      ok: false,
      error:
        'This pull request must be merged through GitHub merge queue. Use Merge when ready instead.'
    })
    await expect(
      mergePR('/repo-root', 7, 'squash', undefined, { owner: 'stablyai', repo: 'orca' })
    ).resolves.toMatchObject({ ok: false })

    expect(
      ghExecFileAsyncMock.mock.calls.filter((call) => call[0].includes('graphql'))
    ).toHaveLength(1)
    expect(ghExecFileAsyncMock.mock.calls[2]?.[0]).toEqual(
      expect.arrayContaining(['-f', 'owner=stablyai', '-f', 'repo=orca', '-f', 'branch=true'])
    )
    expect(ghExecFileAsyncMock.mock.calls[2]?.[0]).not.toContain('-F')
  })

  it('caches unknown merge queue probes after GraphQL failures', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    const prView = {
      number: 7,
      title: 'PR',
      state: 'OPEN',
      url: 'https://github.com/stablyai/orca/pull/7',
      statusCheckRollup: [],
      updatedAt: '2026-04-01T00:00:00Z',
      isDraft: false,
      mergeable: 'MERGEABLE',
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'CLEAN',
      autoMergeRequest: null,
      baseRefName: 'main',
      baseRefOid: 'base-oid',
      headRefOid: 'head-oid'
    }
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify(prView) })
      .mockRejectedValueOnce(new Error('network is down'))
      .mockResolvedValueOnce({ stdout: '{}' })
      .mockResolvedValueOnce({ stdout: JSON.stringify(prView) })
      .mockResolvedValueOnce({ stdout: '{}' })

    await expect(getPRForBranch('/repo-root', 'feature/test', 7)).resolves.toMatchObject({
      mergeQueueRequired: null
    })
    await expect(getPRForBranch('/repo-root', 'feature/test', 7)).resolves.toMatchObject({
      mergeQueueRequired: null
    })

    expect(
      ghExecFileAsyncMock.mock.calls.filter((call) => call[0].includes('graphql'))
    ).toHaveLength(1)
  })

  it('bounds merge metadata cache entries across many base branches', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    let prViewCount = 0
    ghExecFileAsyncMock.mockImplementation(async (args) => {
      if (args.includes('graphql')) {
        return { stdout: JSON.stringify({ data: { repository: { mergeQueue: null } } }) }
      }
      prViewCount += 1
      return {
        stdout: JSON.stringify({
          number: prViewCount,
          title: 'PR',
          state: 'OPEN',
          url: `https://github.com/stablyai/orca/pull/${prViewCount}`,
          statusCheckRollup: [],
          updatedAt: '2026-04-01T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          reviewDecision: 'APPROVED',
          mergeStateStatus: 'CLEAN',
          autoMergeRequest: null,
          baseRefName: `base-${prViewCount}`,
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        })
      }
    })

    for (let i = 0; i < 260; i++) {
      await getPRForBranch('/repo-root', `feature/${i}`, i + 1)
    }

    expect(_getMergeQueueCacheSizeForTests()).toBe(256)
  })

  it('isolates merge metadata for the same slug on different GitHub hosts', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [
        { owner: 'acme', repo: 'widgets', host: 'github.com' },
        { owner: 'acme', repo: 'widgets', host: 'github.acme-corp.com' }
      ],
      headRepo: { owner: 'acme', repo: 'widgets', host: 'github.com' }
    })
    const prView = {
      number: 7,
      title: 'PR',
      state: 'OPEN',
      url: 'https://github.com/acme/widgets/pull/7',
      statusCheckRollup: [],
      updatedAt: '2026-07-16T00:00:00Z',
      isDraft: false,
      mergeable: 'MERGEABLE',
      baseRefName: 'main',
      headRefOid: 'head-oid'
    }
    ghExecFileAsyncMock.mockImplementation(async (args, options) => {
      if (args.includes('graphql')) {
        const enterprise = options?.host === 'github.acme-corp.com'
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                mergeQueue: null,
                autoMergeAllowed: !enterprise
              }
            }
          })
        }
      }
      return { stdout: JSON.stringify(prView) }
    })

    const githubDotCom = await getWorkItemByOwnerRepo(
      '/repo-root',
      { owner: 'acme', repo: 'widgets', host: 'github.com' },
      7,
      'pr'
    )
    const enterprise = await getWorkItemByOwnerRepo(
      '/repo-root',
      { owner: 'acme', repo: 'widgets', host: 'github.acme-corp.com' },
      7,
      'pr'
    )

    expect(githubDotCom?.autoMergeAllowed).toBe(true)
    expect(enterprise?.autoMergeAllowed).toBe(false)
    const graphqlCalls = ghExecFileAsyncMock.mock.calls.filter(([args]) => args.includes('graphql'))
    expect(graphqlCalls).toHaveLength(2)
    expect(graphqlCalls[1]?.[1]).toEqual(expect.objectContaining({ host: 'github.acme-corp.com' }))
  })

  it('rejects explicit work-item lookups outside configured repository candidates', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'acme', repo: 'widgets', host: 'github.com' }],
      headRepo: { owner: 'acme', repo: 'widgets', host: 'github.com' }
    })

    await expect(
      getWorkItemByOwnerRepo(
        '/repo-root',
        { owner: 'victim', repo: 'secrets', host: 'evil.example.test' },
        7,
        'pr'
      )
    ).resolves.toBeNull()

    expect(acquireMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('returns conflicting file details instead of running gh merge when PR is dirty', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify({ stack: null }) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 7,
          title: 'PR',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/7',
          statusCheckRollup: [],
          updatedAt: '2026-04-01T00:00:00Z',
          isDraft: false,
          mergeable: 'CONFLICTING',
          baseRefName: 'main',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        })
      })
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '3\n' })
      .mockResolvedValueOnce({ stdout: 'result-tree-oid\u0000src/conflict.ts\u0000' })

    await expect(
      mergePR('/repo-root', 7, 'squash', undefined, {
        owner: 'stablyai',
        repo: 'orca',
        host: 'github.com'
      })
    ).resolves.toEqual({
      ok: false,
      error:
        'This pull request has merge conflicts and cannot be merged yet.\n' +
        '3 commits behind main (base commit: latest-).\n\n' +
        'Conflicting files:\n' +
        '- src/conflict.ts'
    })

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('does not run merge conflict preflight for SSH-backed repos', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify({ stack: null }) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 7,
          title: 'PR',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/7',
          statusCheckRollup: [],
          updatedAt: '2026-04-01T00:00:00Z',
          isDraft: false,
          mergeable: 'CONFLICTING',
          baseRefName: 'main',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        })
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(
      mergePR('/remote/repo-root', 7, 'squash', 'ssh-1', {
        owner: 'stablyai',
        repo: 'orca',
        host: 'github.com'
      })
    ).resolves.toEqual({ ok: true })

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(3)
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['pr', 'merge', '7', '--squash', '--repo', 'stablyai/orca'],
      expect.objectContaining({
        env: expect.objectContaining({ GH_PROMPT_DISABLED: '1' })
      })
    )
    expect(ghExecFileAsyncMock.mock.calls[0]?.[1]).not.toHaveProperty('cwd')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('blocks review-thread resolve mutations before spawning gh when GraphQL is low', async () => {
    rateLimitGuardMock.mockReturnValue({
      blocked: true,
      remaining: 4,
      limit: 5000,
      resetAt: 1_800_000_000
    })

    await expect(resolveReviewThread('/repo-root', 'thread-1', true)).resolves.toBe(false)

    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    expect(noteRateLimitSpendMock).not.toHaveBeenCalled()
  })
})
