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

import { getPRForBranch, mergePR } from './client'
import { resetGraphQLRateLimitGuardMocks } from './client-test-harness'

const { ghExecFileAsyncMock, getOwnerRepoMock, acquireMock, releaseMock } = clientMocks

describe('GitHub GraphQL rate-limit guard', () => {
  beforeEach(() => {
    resetGraphQLRateLimitGuardMocks(clientMocks)
  })

  afterEach(() => vi.restoreAllMocks())

  it('hydrates GitHub-registered stack metadata for exact linked PRs', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca', host: 'github.com' })
    ghExecFileAsyncMock
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
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 202,
          title: 'Stack API',
          state: 'open',
          html_url: 'https://github.com/stablyai/orca/pull/202',
          head: { ref: 'stack/api', sha: 'api-sha' },
          base: { ref: 'stack/models', sha: 'models-sha' },
          stack: {
            number: 51,
            position: 2,
            size: 2,
            base: { ref: 'main', sha: 'main-sha' }
          }
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                stack: {
                  number: 51,
                  size: 2,
                  baseRefName: 'main',
                  entries: {
                    nodes: [
                      {
                        position: 1,
                        pullRequest: {
                          number: 201,
                          title: 'Stack models',
                          url: 'https://github.com/stablyai/orca/pull/201',
                          state: 'OPEN',
                          isDraft: false,
                          mergeable: 'MERGEABLE',
                          statusCheckRollup: { state: 'SUCCESS' }
                        }
                      },
                      {
                        position: 2,
                        pullRequest: {
                          number: 202,
                          title: 'Stack API',
                          url: 'https://github.com/stablyai/orca/pull/202',
                          state: 'OPEN',
                          isDraft: false,
                          mergeable: 'MERGEABLE',
                          statusCheckRollup: { state: 'SUCCESS' }
                        }
                      }
                    ]
                  }
                }
              }
            }
          }
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            repository: {
              mergeQueue: null,
              ref: { rules: { nodes: [{ type: 'MERGE_QUEUE' }] } }
            }
          }
        })
      })

    const pr = await getPRForBranch('/repo-root', 'stack/api', 202)

    expect(pr?.stack).toMatchObject({
      number: 51,
      position: 2,
      size: 2,
      baseRefName: 'main',
      entries: [
        { number: 201, position: 1 },
        { number: 202, position: 2 }
      ]
    })
    expect(pr?.mergeQueueRequired).toBe(true)
    const mergeQueueMetadataCall = ghExecFileAsyncMock.mock.calls.find(
      ([args]) => args.includes('graphql') && args.includes('branch=main')
    )
    expect(mergeQueueMetadataCall?.[0]).toEqual(expect.arrayContaining(['-f', 'branch=main']))
  })

  const validStackHeadSha = 'a'.repeat(40)
  const validStackBaseSha = 'b'.repeat(40)
  const validSha256HeadSha = 'c'.repeat(64)

  it.each([
    {
      objectFormat: 'SHA-1 with a base SHA',
      headSha: validStackHeadSha,
      baseSha: validStackBaseSha
    },
    {
      objectFormat: 'SHA-256 without a base SHA',
      headSha: validSha256HeadSha,
      baseSha: undefined
    }
  ])('uses async merge only for GitHub-registered stacks using $objectFormat', async (scenario) => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 202,
          title: 'Stack API',
          state: 'open',
          head: { ref: 'stack/api', sha: scenario.headSha },
          base: { ref: 'stack/models', sha: 'models-sha' },
          stack: {
            number: 51,
            position: 2,
            size: 2,
            base: {
              ref: 'main',
              ...(scenario.baseSha ? { sha: scenario.baseSha } : {})
            }
          }
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ data: { repository: { mergeQueue: { id: 'MQ_kw' } } } })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ status: 'enqueued', details: { message: 'Queued' } })
      })

    await expect(
      mergePR('/repo-root', 202, 'squash', undefined, {
        owner: 'stablyai',
        repo: 'orca',
        host: 'github.com'
      })
    ).resolves.toEqual({ ok: true })

    const mergeCall = ghExecFileAsyncMock.mock.calls.find(([args]) =>
      args.includes('repos/stablyai/orca/pulls/202/merge-async')
    )
    expect(mergeCall?.[0]).toEqual(
      expect.arrayContaining([
        'PUT',
        'repos/stablyai/orca/pulls/202/merge-async',
        'merge_action=merge_queue',
        `sha=${scenario.headSha}`
      ])
    )
    expect(mergeCall?.[0]).not.toContain('merge_method=squash')
    expect(acquireMock).toHaveBeenCalledTimes(2)
    expect(releaseMock).toHaveBeenCalledTimes(2)
    expect(
      ghExecFileAsyncMock.mock.calls.some(([args]) => args[0] === 'pr' && args[1] === 'merge')
    ).toBe(false)
  })

  it('never falls back to legacy merge after an async stack merge transport failure', async () => {
    ghExecFileAsyncMock
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
      ghExecFileAsyncMock.mock.calls.some(([args]) => args[0] === 'pr' && args[1] === 'merge')
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
      ghExecFileAsyncMock.mockRejectedValueOnce(scenario.probeResponse)
    } else {
      ghExecFileAsyncMock.mockResolvedValueOnce(scenario.probeResponse)
    }
    // Why: disabling the guard must expose the legacy merge fallthrough, not fail on an unstubbed call.
    ghExecFileAsyncMock
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
      .soft(ghExecFileAsyncMock.mock.calls.map(([args]) => args))
      .toEqual([['api', 'repos/stablyai/orca/pulls/202']])
    expect.soft(ghExecFileAsyncMock.mock.calls[0]?.[1]).toEqual(scenario.expectedOptions)
    expect
      .soft(
        ghExecFileAsyncMock.mock.calls.some(([args]) =>
          args.includes('repos/stablyai/orca/pulls/202/merge-async')
        )
      )
      .toBe(false)
    expect
      .soft(
        ghExecFileAsyncMock.mock.calls.some(([args]) => args[0] === 'pr' && args[1] === 'merge')
      )
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

  it.each([
    { stackShape: 'omits stack', stackField: {} },
    { stackShape: 'sets stack to null', stackField: { stack: null } }
  ])('keeps legacy merge when an ordinary GitHub response $stackShape', async (scenario) => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 13866,
          title: 'Fail closed on unavailable stack metadata',
          state: 'open',
          head: {
            ref: 'sta-3924-stack-merge-fail-closed',
            sha: validStackHeadSha
          },
          base: { ref: 'main', sha: validStackBaseSha },
          ...scenario.stackField
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 13866,
          title: 'Fail closed on unavailable stack metadata',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/13866',
          statusCheckRollup: [],
          updatedAt: '2026-08-11T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          baseRefOid: validStackBaseSha,
          headRefName: 'sta-3924-stack-merge-fail-closed',
          headRefOid: validStackHeadSha
        })
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(
      mergePR('/repo-root', 13866, 'squash', undefined, {
        owner: 'stablyai',
        repo: 'orca',
        host: 'github.com'
      })
    ).resolves.toEqual({ ok: true })

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['pr', 'merge', '13866', '--squash', '--repo', 'stablyai/orca'],
      expect.objectContaining({ env: expect.objectContaining({ GH_PROMPT_DISABLED: '1' }) })
    )
    expect(acquireMock).toHaveBeenCalledTimes(1)
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })

  it('keeps legacy merge for unregistered dependent PR chains', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 202,
          title: 'Dependent API',
          state: 'open',
          head: { ref: 'feature/api', sha: 'api-sha' },
          base: { ref: 'feature/models', sha: 'models-sha' },
          stack: null
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 202,
          title: 'Dependent API',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/202',
          statusCheckRollup: [],
          updatedAt: '2026-08-10T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'feature/models',
          headRefOid: 'api-sha'
        })
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(
      mergePR('/repo-root', 202, 'squash', undefined, {
        owner: 'stablyai',
        repo: 'orca',
        host: 'github.com'
      })
    ).resolves.toEqual({ ok: true })

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['pr', 'merge', '202', '--squash', '--repo', 'stablyai/orca'],
      expect.objectContaining({ env: expect.objectContaining({ GH_PROMPT_DISABLED: '1' }) })
    )
  })
})
