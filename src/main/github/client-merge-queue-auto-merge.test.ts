import type * as GitExecFileModule from '../git/command-runner/git-exec-file'
import type * as GhExecFileModule from '../git/command-runner/hosted-cli/gh-exec-file'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GitExecFileModule>()),
  gitExecFileAsync: clientMocks.gitExecFileAsyncMock
}))

vi.mock('../git/command-runner/hosted-cli/gh-exec-file', async (importOriginal) => ({
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

import { resolveReviewThread } from './client/update/resolve-review-thread'
import { setPRAutoMerge } from './client/merge/pr-auto-merge'
import { _getMergeQueueCacheSizeForTests } from './client/detect/repository-merge-metadata-cache'
import {
  installIndependentCheckFixtures,
  resetGraphQLRateLimitGuardMocks
} from './client-test-harness'

const {
  resolvePRRepositoryCandidatesMock,
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
