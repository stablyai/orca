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
import { mergePR } from './client/merge/merge-pr'
import {
  installIndependentCheckFixtures,
  resetGraphQLRateLimitGuardMocks
} from './client-test-harness'

const metadataRequests = vi.fn()
const unexpectedChecks: string[][] = []
afterEach(() => expect(unexpectedChecks).toEqual([]))

describe('GitHub GraphQL rate-limit guard', () => {
  beforeEach(() => {
    resetGraphQLRateLimitGuardMocks(clientMocks)
    installIndependentCheckFixtures(clientMocks, metadataRequests, unexpectedChecks)
  })

  afterEach(() => vi.restoreAllMocks())

  const validStackHeadSha = 'a'.repeat(40)
  const validStackBaseSha = 'b'.repeat(40)

  it('never falls back to legacy merge after an async stack merge transport failure', async () => {
    metadataRequests
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 202,
          state: 'open',
          head: { ref: 'stack/api', sha: validStackHeadSha },
          base: { ref: 'stack/models', sha: 'models-sha' },
          stack: {
            number: 51,
            position: 2,
            size: 2,
            base: { ref: 'main', sha: validStackBaseSha }
          }
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ data: { repository: { mergeQueue: null } } })
      })
      .mockRejectedValueOnce(new Error('socket closed after request submission'))

    await expect(
      mergePR('/repo-root', 202, 'squash', undefined, {
        owner: 'stablyai',
        repo: 'orca',
        host: 'github.com'
      })
    ).resolves.toEqual({ ok: false, error: 'socket closed after request submission' })
    expect(
      metadataRequests.mock.calls.some(([args]) => args[0] === 'pr' && args[1] === 'merge')
    ).toBe(false)
  })
})
