import type * as GithubRepositoryIdentityModule from '../../repositories/github-repository-identity'
import type * as GhExecFileModule from '../../../git/command-runner/hosted-cli/gh-exec-file'
import type * as GithubApiRepositoryModule from '../../repositories/github-api-repository'
import type * as GithubApiRepositoryRemoteProbeModule from '../../repositories/github-api-repository-remote-probe'
import type * as GitExecFileModule from '../../../git/command-runner/git-exec-file'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as GitHubEnterpriseRepositoryModule from '../../repositories/github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('../client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('../../execution/github-legacy-command', () =>
  moduleMocks.githubLegacyCommandModuleMock(clientMocks)
)

vi.mock('../../repositories/github-owner-repo-selection', () =>
  moduleMocks.githubOwnerSelectionModuleMock(clientMocks)
)

vi.mock('../../repositories/github-repository-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof GithubRepositoryIdentityModule>()),
  ...moduleMocks.githubRepositoryIdentityModuleMock(clientMocks)
}))

vi.mock('../../api/gh-error-classification', () =>
  moduleMocks.githubErrorClassificationModuleMock()
)

vi.mock('../../execution/github-operation-slots', () =>
  moduleMocks.githubOperationSlotsModuleMock(clientMocks)
)

vi.mock('../../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GitExecFileModule>()),
  gitExecFileAsync: clientMocks.gitExecFileAsyncMock
}))

vi.mock('../../../git/command-runner/hosted-cli/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GhExecFileModule>()),
  ...moduleMocks.githubHostedCliModuleMock(clientMocks)
}))
vi.mock('../../../git/objects/local-git-object-quarantine', () =>
  moduleMocks.localGitObjectQuarantineModuleMock()
)
vi.mock('../../repositories/local-git-config-signature', () =>
  moduleMocks.localGitConfigSignatureModuleMock(clientMocks)
)
vi.mock('../../repositories/github-enterprise-repository', async (importOriginal) =>
  moduleMocks.githubEnterpriseRepositoryModuleMock(
    await importOriginal<typeof GitHubEnterpriseRepositoryModule>()
  )
)
vi.mock('../../api/rate-limit', () => moduleMocks.rateLimitModuleMock(clientMocks))
vi.mock('../../repositories/github-api-repository', async (importOriginal) =>
  moduleMocks.githubApiRepositoryModuleMock(
    clientMocks,
    await importOriginal<typeof GithubApiRepositoryModule>()
  )
)

vi.mock('../../repositories/github-api-repository-remote-probe', async (importOriginal) =>
  moduleMocks.githubApiRepositoryRemoteProbeModuleMock(
    clientMocks,
    await importOriginal<typeof GithubApiRepositoryRemoteProbeModule>()
  )
)
import { getWorkItemByOwnerRepo } from './get-work-item'

import {
  installIndependentCheckFixtures,
  resetGraphQLRateLimitGuardMocks
} from '../client-test-harness'

const { resolvePRRepositoryCandidatesMock } = clientMocks

const metadataRequests = vi.fn()
const unexpectedChecks: string[][] = []
afterEach(() => expect(unexpectedChecks).toEqual([]))

describe('GitHub GraphQL rate-limit guard', () => {
  beforeEach(() => {
    resetGraphQLRateLimitGuardMocks(clientMocks)
    installIndependentCheckFixtures(clientMocks, metadataRequests, unexpectedChecks)
  })

  afterEach(() => vi.restoreAllMocks())

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
})
