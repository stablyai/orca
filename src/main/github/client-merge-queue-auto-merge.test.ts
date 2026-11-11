import type * as GitExecFileModule from '../git/command-runner/git-exec-file'
import type * as GhExecFileModule from '../git/command-runner/gh-exec-file'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))
vi.mock('../git/runner', () => moduleMocks.gitRunnerModuleMock(clientMocks))

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GitExecFileModule>()),
  gitExecFileAsync: clientMocks.gitExecFileAsyncMock
}))

vi.mock('../git/command-runner/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GhExecFileModule>()),
  ghExecFileAsync: clientMocks.ghExecFileAsyncMock
}))
vi.mock('../git/local-git-object-quarantine', () =>
  moduleMocks.localGitObjectQuarantineModuleMock()
)
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
import { getWorkItemByOwnerRepo } from './client/fetch/get-work-item'
import { mergePR } from './client/merge/merge-pr'
import { resolveReviewThread } from './client/update/resolve-review-thread'
import { setPRAutoMerge } from './client/merge/pr-auto-merge'
import { _getMergeQueueCacheSizeForTests } from './client/detect/repository-merge-metadata-cache'
import {
  installIndependentCheckFixtures,
  resetGraphQLRateLimitGuardMocks
} from './client-test-harness'

const {
  resolvePRRepositoryCandidatesMock,
  gitExecFileAsyncMock,
  rateLimitGuardMock,
  noteRateLimitSpendMock,
  acquireMock
} = clientMocks

const metadataRequests = vi.fn()
const unexpectedChecks: string[][] = []
afterEach(() => expect(unexpectedChecks).toEqual([]))

describe('GitHub GraphQL rate-limit guard', () => {
  beforeEach(() => {
    resetGraphQLRateLimitGuardMocks(clientMocks)
    installIndependentCheckFixtures(clientMocks, metadataRequests, unexpectedChecks)
  })

  afterEach(() => vi.restoreAllMocks())

  it('enables auto-merge without invoking the direct merge command', async () => {
    metadataRequests
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
      metadataRequests.mock.calls.some((call) =>
        (call[0] as string[]).some((arg) => arg.includes('enablePullRequestAutoMerge'))
      )
    ).toBe(true)
    expect(
      metadataRequests.mock.calls.some(
        (call) =>
          call[0][0] === 'pr' && call[0][1] === 'merge' && (call[0] as string[]).includes('--auto')
      )
    ).toBe(false)
  })

  it('rejects auto-merge for GitHub-registered stacks', async () => {
    metadataRequests.mockResolvedValueOnce({
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
    ).resolves.toMatchObject({
      ok: false,
      error: 'GitHub does not support auto-merge for stacked pull requests.'
    })
    expect(metadataRequests).toHaveBeenCalledTimes(1)
  })

  it('preserves a provider rejection when eligibility changes before enabling auto-merge', async () => {
    const providerError =
      'gh: Pull request Pull request is in unstable status (enablePullRequestAutoMerge)'
    metadataRequests
      .mockResolvedValueOnce({ stdout: JSON.stringify({ stack: null }) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ id: 'PR_kwDO123', headRefOid: 'head-oid' })
      })
      .mockRejectedValueOnce(new Error(providerError))

    await expect(
      setPRAutoMerge('/repo-root', 7, true, 'squash', undefined, {
        owner: 'stablyai',
        repo: 'orca',
        host: 'github.com'
      })
    ).resolves.toMatchObject({
      ok: false,
      error: `Failed to enable auto-merge for pull request: ${providerError}`
    })
    expect(
      metadataRequests.mock.calls.some(([args]) => args[0] === 'pr' && args[1] === 'merge')
    ).toBe(false)
  })

  it('blocks direct merge when GitHub reports required approval', async () => {
    metadataRequests
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

    expect(metadataRequests).toHaveBeenCalledTimes(3)
    expect(metadataRequests.mock.calls[2]?.[0]).toContain('graphql')
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
    metadataRequests
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

    expect(metadataRequests.mock.calls.filter((call) => call[0].includes('graphql'))).toHaveLength(
      1
    )
    expect(metadataRequests.mock.calls[2]?.[0]).toEqual(
      expect.arrayContaining(['-f', 'owner=stablyai', '-f', 'repo=orca', '-f', 'branch=true'])
    )
    expect(metadataRequests.mock.calls[2]?.[0]).not.toContain('-F')
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
    expect(metadataRequests).not.toHaveBeenCalled()
  })

  it('lets a link preview read another repository only on a configured host', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [{ owner: 'acme', repo: 'widgets', host: 'github.com' }],
      headRepo: { owner: 'acme', repo: 'widgets', host: 'github.com' }
    })
    const other = { owner: 'other', repo: 'tools', host: 'github.com' }
    const unknownHost = { owner: 'victim', repo: 'secrets', host: 'evil.example.test' }

    await expect(getWorkItemByOwnerRepo('/repo-root', other, 7, 'pr')).resolves.toBeNull()
    await expect(
      getWorkItemByOwnerRepo('/repo-root', unknownHost, 7, 'pr', undefined, {}, { preview: true })
    ).resolves.toBeNull()
    expect(metadataRequests).not.toHaveBeenCalled()

    metadataRequests.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 7,
        title: 'Tools PR',
        state: 'open',
        html_url: 'https://github.com/other/tools/pull/7',
        updated_at: '2026-04-01T00:00:00Z',
        user: { login: 'someone' },
        labels: [],
        head: { ref: 'feature', sha: 'head-oid' },
        base: { ref: 'main' }
      })
    })
    await expect(
      getWorkItemByOwnerRepo('/repo-root', other, 7, 'pr', undefined, {}, { preview: true })
    ).resolves.toMatchObject({ title: 'Tools PR' })
    expect(metadataRequests.mock.calls[0]?.[0]).toEqual(['api', 'repos/other/tools/pulls/7'])
  })

  it('returns conflicting file details instead of running gh merge when PR is dirty', async () => {
    metadataRequests
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
      .mockResolvedValueOnce({ stdout: '/repo-root/.git\n' })
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

    expect(metadataRequests).toHaveBeenCalledTimes(2)
  })

  it('blocks review-thread resolve mutations before spawning gh when GraphQL is low', async () => {
    rateLimitGuardMock.mockReturnValue({
      blocked: true,
      remaining: 4,
      limit: 5000,
      resetAt: 1_800_000_000
    })

    await expect(resolveReviewThread('/repo-root', 'thread-1', true)).resolves.toBe(false)

    expect(metadataRequests).not.toHaveBeenCalled()
    expect(noteRateLimitSpendMock).not.toHaveBeenCalled()
  })
})
