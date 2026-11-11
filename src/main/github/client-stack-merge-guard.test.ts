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

const { acquireMock, releaseMock } = clientMocks

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

  const stackMetadataUnavailableError =
    'Could not verify GitHub pull request stack metadata. Refresh and try again.'

  it.each([
    {
      failure: 'local transport failure',
      repoPath: '/repo-root',
      connectionId: undefined,
      probeResponse: new Error('stack metadata unavailable'),
      expectedError: stackMetadataUnavailableError,
      expectedDiagnostic: 'stack metadata unavailable',
      expectedOptions: { cwd: '/repo-root', host: 'github.com' }
    },
    {
      failure: 'GitHub Enterprise transport failure',
      repoPath: '/repo-root',
      connectionId: undefined,
      probeResponse: new Error('enterprise stack metadata unavailable'),
      expectedError: stackMetadataUnavailableError,
      expectedDiagnostic: 'enterprise stack metadata unavailable',
      expectedOptions: { cwd: '/repo-root', host: 'github.enterprise.test' }
    },
    {
      failure: 'unparsable probe response over SSH',
      repoPath: '/remote/repo-root',
      connectionId: 'ssh-1',
      probeResponse: { stdout: '' },
      expectedError: stackMetadataUnavailableError,
      expectedDiagnostic: 'invalid JSON response',
      expectedOptions: { host: 'github.com' }
    },
    {
      failure: 'valid JSON with a non-object payload',
      repoPath: '/repo-root',
      connectionId: undefined,
      probeResponse: { stdout: 'null' },
      expectedError: stackMetadataUnavailableError,
      expectedDiagnostic: 'invalid response shape',
      expectedOptions: { cwd: '/repo-root', host: 'github.com' }
    },
    {
      failure: 'valid JSON with an array payload',
      repoPath: '/repo-root',
      connectionId: undefined,
      probeResponse: { stdout: '[]' },
      expectedError: stackMetadataUnavailableError,
      expectedDiagnostic: 'invalid response shape',
      expectedOptions: { cwd: '/repo-root', host: 'github.com' }
    },
    {
      failure: 'present primitive stack metadata',
      repoPath: '/repo-root',
      connectionId: undefined,
      probeResponse: {
        stdout: JSON.stringify({
          number: 202,
          head: { sha: validStackHeadSha },
          stack: true
        })
      },
      expectedError: stackMetadataUnavailableError,
      expectedDiagnostic: 'malformed stack',
      expectedOptions: { cwd: '/repo-root', host: 'github.com' }
    },
    {
      failure: 'malformed stack response',
      repoPath: '/repo-root',
      connectionId: undefined,
      probeResponse: {
        stdout: JSON.stringify({
          number: 202,
          head: { sha: validStackHeadSha },
          stack: {
            number: 51,
            position: 2,
            size: '2',
            base: { ref: 'main', sha: validStackBaseSha }
          }
        })
      },
      expectedError: stackMetadataUnavailableError,
      expectedDiagnostic: 'malformed stack',
      expectedOptions: { cwd: '/repo-root', host: 'github.com' }
    },
    {
      failure: 'incoherent stack position',
      repoPath: '/repo-root',
      connectionId: undefined,
      probeResponse: {
        stdout: JSON.stringify({
          number: 202,
          head: { sha: validStackHeadSha },
          stack: {
            number: 51,
            position: 3,
            size: 2,
            base: { ref: 'main', sha: validStackBaseSha }
          }
        })
      },
      expectedError: stackMetadataUnavailableError,
      expectedDiagnostic: 'malformed stack',
      expectedOptions: { cwd: '/repo-root', host: 'github.com' }
    },
    {
      failure: 'non-positive stack number',
      repoPath: '/repo-root',
      connectionId: undefined,
      probeResponse: {
        stdout: JSON.stringify({
          number: 202,
          head: { sha: validStackHeadSha },
          stack: {
            number: 0,
            position: 1,
            size: 2,
            base: { ref: 'main', sha: validStackBaseSha }
          }
        })
      },
      expectedError: stackMetadataUnavailableError,
      expectedDiagnostic: 'malformed stack',
      expectedOptions: { cwd: '/repo-root', host: 'github.com' }
    },
    {
      failure: 'fractional stack size',
      repoPath: '/repo-root',
      connectionId: undefined,
      probeResponse: {
        stdout: JSON.stringify({
          number: 202,
          head: { sha: validStackHeadSha },
          stack: {
            number: 51,
            position: 1,
            size: 1.5,
            base: { ref: 'main', sha: validStackBaseSha }
          }
        })
      },
      expectedError: stackMetadataUnavailableError,
      expectedDiagnostic: 'malformed stack',
      expectedOptions: { cwd: '/repo-root', host: 'github.com' }
    },
    {
      failure: 'unsafe stack number',
      repoPath: '/repo-root',
      connectionId: undefined,
      probeResponse: {
        stdout: JSON.stringify({
          number: 202,
          head: { sha: validStackHeadSha },
          stack: {
            number: Number.MAX_SAFE_INTEGER + 1,
            position: 1,
            size: 2,
            base: { ref: 'main', sha: validStackBaseSha }
          }
        })
      },
      expectedError: stackMetadataUnavailableError,
      expectedDiagnostic: 'malformed stack',
      expectedOptions: { cwd: '/repo-root', host: 'github.com' }
    },
    {
      failure: 'blank stack base ref',
      repoPath: '/repo-root',
      connectionId: undefined,
      probeResponse: {
        stdout: JSON.stringify({
          number: 202,
          head: { sha: validStackHeadSha },
          stack: {
            number: 51,
            position: 2,
            size: 2,
            base: { ref: '  ', sha: validStackBaseSha }
          }
        })
      },
      expectedError: stackMetadataUnavailableError,
      expectedDiagnostic: 'malformed stack',
      expectedOptions: { cwd: '/repo-root', host: 'github.com' }
    },
    {
      failure: 'invalid stack base SHA',
      repoPath: '/repo-root',
      connectionId: undefined,
      probeResponse: {
        stdout: JSON.stringify({
          number: 202,
          head: { sha: validStackHeadSha },
          stack: {
            number: 51,
            position: 2,
            size: 2,
            base: { ref: 'main', sha: 123 }
          }
        })
      },
      expectedError: stackMetadataUnavailableError,
      expectedDiagnostic: 'malformed stack',
      expectedOptions: { cwd: '/repo-root', host: 'github.com' }
    },
    {
      failure: 'invalid string stack base SHA',
      repoPath: '/repo-root',
      connectionId: undefined,
      probeResponse: {
        stdout: JSON.stringify({
          number: 202,
          head: { sha: validStackHeadSha },
          stack: {
            number: 51,
            position: 2,
            size: 2,
            base: { ref: 'main', sha: 'not-a-git-object-id' }
          }
        })
      },
      expectedError: stackMetadataUnavailableError,
      expectedDiagnostic: 'malformed stack',
      expectedOptions: { cwd: '/repo-root', host: 'github.com' }
    },
    {
      failure: 'registered stack response without a head SHA',
      repoPath: '/repo-root',
      connectionId: undefined,
      probeResponse: {
        stdout: JSON.stringify({
          number: 202,
          head: { ref: 'stack/api' },
          stack: {
            number: 51,
            position: 2,
            size: 2,
            base: { ref: 'main', sha: validStackBaseSha }
          }
        })
      },
      expectedError: stackMetadataUnavailableError,
      expectedDiagnostic: 'missing head SHA',
      expectedOptions: { cwd: '/repo-root', host: 'github.com' }
    },
    {
      failure: 'registered stack response with an invalid head SHA',
      repoPath: '/repo-root',
      connectionId: undefined,
      probeResponse: {
        stdout: JSON.stringify({
          number: 202,
          head: { ref: 'stack/api', sha: {} },
          stack: {
            number: 51,
            position: 2,
            size: 2,
            base: { ref: 'main', sha: validStackBaseSha }
          }
        })
      },
      expectedError: stackMetadataUnavailableError,
      expectedDiagnostic: 'missing head SHA',
      expectedOptions: { cwd: '/repo-root', host: 'github.com' }
    },
    {
      failure: 'registered stack response with an invalid string head SHA',
      repoPath: '/repo-root',
      connectionId: undefined,
      probeResponse: {
        stdout: JSON.stringify({
          number: 202,
          head: { ref: 'stack/api', sha: 'not-a-git-object-id' },
          stack: {
            number: 51,
            position: 2,
            size: 2,
            base: { ref: 'main', sha: validStackBaseSha }
          }
        })
      },
      expectedError: stackMetadataUnavailableError,
      expectedDiagnostic: 'missing head SHA',
      expectedOptions: { cwd: '/repo-root', host: 'github.com' }
    }
  ])('fails closed on $failure', async (scenario) => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    if (scenario.probeResponse instanceof Error) {
      metadataRequests.mockRejectedValueOnce(scenario.probeResponse)
    } else {
      metadataRequests.mockResolvedValueOnce(scenario.probeResponse)
    }
    // Stub legacy merge fallthrough so disabling the guard cannot fail on an unrelated missing fixture.
    metadataRequests
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 202,
          title: 'Stack API',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/202',
          statusCheckRollup: [],
          updatedAt: '2026-08-10T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'stack/models',
          headRefName: 'stack/api',
          headRefOid: 'api-sha'
        })
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    const result = await mergePR(scenario.repoPath, 202, 'squash', scenario.connectionId, {
      owner: 'stablyai',
      repo: 'orca',
      host: scenario.expectedOptions.host
    })

    expect.soft(result).toEqual({ ok: false, error: scenario.expectedError })
    expect
      .soft(metadataRequests.mock.calls.map(([args]) => args))
      .toEqual([['api', 'repos/stablyai/orca/pulls/202', '--include']])
    expect.soft(metadataRequests.mock.calls[0]?.[1]).toEqual(scenario.expectedOptions)
    expect
      .soft(
        metadataRequests.mock.calls.some(([args]) =>
          args.includes('repos/stablyai/orca/pulls/202/merge-async')
        )
      )
      .toBe(false)
    expect
      .soft(metadataRequests.mock.calls.some(([args]) => args[0] === 'pr' && args[1] === 'merge'))
      .toBe(false)
    expect.soft(acquireMock).toHaveBeenCalledTimes(1)
    expect.soft(releaseMock).toHaveBeenCalledTimes(1)
    expect
      .soft(consoleWarnSpy)
      .toHaveBeenCalledWith(
        'mergePR stack metadata probe failed for stablyai/orca#202:',
        scenario.expectedDiagnostic
      )
    expect.soft(consoleWarnSpy).toHaveBeenCalledTimes(1)
  })
})
