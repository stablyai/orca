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
import { getGitHubIssueLinkMetadata } from '../../workspace-links/github-issue-link-metadata'

import {
  installIndependentCheckFixtures,
  resetGraphQLRateLimitGuardMocks
} from '../client-test-harness'

const { resolvePRRepositoryCandidatesMock } = clientMocks

const metadataRequests = vi.fn()
const unexpectedChecks: string[][] = []
afterEach(() => expect(unexpectedChecks).toEqual([]))

describe('GitHub work item link routing', () => {
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

  it('reads issue link metadata from the linked repository on the configured host', async () => {
    const configured = { owner: 'acme', repo: 'widgets', host: 'github.example.test' }
    const linked = { owner: 'other', repo: 'tools', host: 'github.example.test' }
    const issue = {
      number: 7,
      title: 'Fix the tools installer',
      url: 'https://github.example.test/other/tools/issues/7'
    }
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [configured],
      headRepo: configured
    })
    metadataRequests.mockImplementation(async (args: string[]) => {
      if (args[1] !== 'graphql' || !args.includes('owner=other') || !args.includes('repo=tools')) {
        throw new Error('Unrecognized issue repository')
      }
      return {
        stdout: JSON.stringify({
          data: { repository: { issue: args.includes('number=7') ? issue : null } }
        })
      }
    })

    await expect(
      getGitHubIssueLinkMetadata('/repo-root', 7, undefined, {}, linked)
    ).resolves.toEqual({
      number: 7,
      title: 'Fix the tools installer',
      url: 'https://github.example.test/other/tools/issues/7'
    })
    expect(metadataRequests.mock.calls[0]?.[1]).toMatchObject({ host: 'github.example.test' })
    await expect(
      getGitHubIssueLinkMetadata('/repo-root', 8, undefined, {}, linked)
    ).resolves.toBeNull()
    await expect(
      getGitHubIssueLinkMetadata('/repo-root', 7, undefined, {}, { ...linked, host: 'github.com' })
    ).resolves.toBeNull()
  })
})
