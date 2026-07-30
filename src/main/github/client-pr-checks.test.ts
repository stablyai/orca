import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  execFileAsyncMock,
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getIssueOwnerRepoMock,
  gitExecFileAsyncMock,
  extractExecErrorMock,
  getRateLimitMock,
  repositoryRateLimitGuardMock,
  noteRepositoryRateLimitSpendMock,
  spendsSharedGitHubComQuotaMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getIssueOwnerRepoMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  extractExecErrorMock: vi.fn((err: unknown) => {
    if (err && typeof err === 'object') {
      const e = err as { stderr?: unknown; stdout?: unknown; message?: unknown }
      return {
        stderr: typeof e.stderr === 'string' ? e.stderr : String(e.message ?? err),
        stdout: typeof e.stdout === 'string' ? e.stdout : ''
      }
    }
    return { stderr: String(err), stdout: '' }
  }),
  getRateLimitMock: vi.fn(),
  repositoryRateLimitGuardMock: vi.fn(() => ({ blocked: false })),
  noteRepositoryRateLimitSpendMock: vi.fn(),
  spendsSharedGitHubComQuotaMock: vi.fn<
    (repository?: { host?: string } | null, options?: { wslDistro?: string }) => boolean
  >(() => true),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  execFileAsync: execFileAsyncMock,
  ghExecFileAsync: ghExecFileAsyncMock,
  githubRepoContext: (
    repoPath: string,
    connectionId?: string | null,
    localGitOptions: { wslDistro?: string } = {}
  ) => ({
    repoPath,
    connectionId: connectionId ?? null,
    ...localGitOptions
  }),
  ghRepoExecOptions: (context: { repoPath: string; wslDistro?: string }) => ({
    cwd: context.repoPath,
    ...(context.wslDistro ? { wslDistro: context.wslDistro } : {})
  }),
  getOwnerRepo: getOwnerRepoMock,
  getIssueOwnerRepo: getIssueOwnerRepoMock,
  // Why: origin repository resolution calls getOwnerRepoForRemote, not getOwnerRepo.
  getOwnerRepoForRemote: (
    repoPath: string,
    remoteName: string,
    connectionId?: string | null,
    localGitOptions?: unknown
  ) =>
    remoteName === 'origin'
      ? getOwnerRepoMock(repoPath, connectionId, localGitOptions)
      : Promise.resolve(null),
  extractExecError: extractExecErrorMock,
  acquire: acquireMock,
  release: releaseMock,
  _resetOwnerRepoCache: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./rate-limit', () => ({
  getRateLimit: getRateLimitMock,
  repositoryRateLimitGuard: repositoryRateLimitGuardMock,
  noteRepositoryRateLimitSpend: noteRepositoryRateLimitSpendMock,
  spendsSharedGitHubComQuota: spendsSharedGitHubComQuotaMock
}))

import { getPRChecks, rerunPRChecks, _resetOwnerRepoCache } from './client'

import { _resetOriginGitHubApiRepositoryCache } from './github-api-repository'

// The origin-repository cache is module-level state; reset it so slugs
// resolved by one test cannot leak into the next.
beforeEach(() => {
  _resetOriginGitHubApiRepositoryCache()
})

function graphQLChecksResponse({
  contexts = [],
  checkSuites = [],
  headRefOid = 'head-oid'
}: {
  contexts?: unknown[]
  checkSuites?: unknown[]
  headRefOid?: string
} = {}): { stdout: string } {
  return {
    stdout: JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            headRefOid,
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: { contexts: { nodes: contexts } },
                    checkSuites: { nodes: checkSuites }
                  }
                }
              ]
            }
          }
        }
      }
    })
  }
}

function graphQLCheckRun(
  overrides: Partial<{
    databaseId: number
    name: string
    status: string
    conclusion: string | null
    detailsUrl: string | null
    url: string | null
    checkSuiteId: number | null
    workflowRunId: number | null
  }> = {}
): Record<string, unknown> {
  const checkSuiteId = overrides.checkSuiteId ?? 1000
  const workflowRunId = overrides.workflowRunId ?? 1
  return {
    __typename: 'CheckRun',
    databaseId: overrides.databaseId ?? 88,
    name: overrides.name ?? 'build',
    status: overrides.status ?? 'COMPLETED',
    conclusion: overrides.conclusion ?? 'SUCCESS',
    detailsUrl: overrides.detailsUrl ?? 'https://github.com/acme/widgets/actions/runs/1',
    url: overrides.url ?? 'https://github.com/acme/widgets/runs/88',
    checkSuite: {
      databaseId: checkSuiteId,
      workflowRun: workflowRunId === null ? null : { databaseId: workflowRunId }
    }
  }
}

function graphQLStatusContext(
  overrides: Partial<{
    context: string
    state: string
    targetUrl: string | null
  }> = {}
): Record<string, unknown> {
  return {
    __typename: 'StatusContext',
    context: overrides.context ?? 'continuous-integration/jenkins/pr-merge',
    state: overrides.state ?? 'PENDING',
    targetUrl: overrides.targetUrl ?? 'https://jenkins.example.com/job/merge/1'
  }
}

function graphQLCheckSuite(
  overrides: Partial<{
    databaseId: number
    status: string
    conclusion: string | null
    url: string | null
    app: { name?: string | null; slug?: string | null } | null
  }> = {}
): Record<string, unknown> {
  const databaseId = overrides.databaseId ?? 1001
  return {
    databaseId,
    status: overrides.status ?? 'COMPLETED',
    conclusion: overrides.conclusion ?? 'ACTION_REQUIRED',
    url:
      overrides.url ??
      `https://github.com/acme/widgets/commit/head-oid/checks?check_suite_id=${databaseId}`,
    app: overrides.app ?? { name: 'GitHub Actions', slug: 'github-actions' }
  }
}

function expectGraphQLRollupCall(callIndex = 1, noCache = false): void {
  const args = ghExecFileAsyncMock.mock.calls[callIndex - 1]?.[0] as string[]
  expect(args.slice(0, 2)).toEqual(['api', 'graphql'])
  expect(args).toEqual(
    expect.arrayContaining(['-f', 'owner=acme', '-f', 'repo=widgets', '-F', 'pr=42'])
  )
  if (noCache) {
    expect(args).not.toContain('--cache')
  } else {
    expect(args).toEqual(expect.arrayContaining(['--cache', '60s']))
  }
  const queryArg = args.find((arg) => arg.startsWith('query='))
  expect(queryArg).toContain('statusCheckRollup')
  expect(queryArg).toContain('checkSuites')
}

describe('getPRChecks', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    extractExecErrorMock.mockClear()
    getRateLimitMock.mockReset()
    getRateLimitMock.mockResolvedValue({ resources: {} })
    repositoryRateLimitGuardMock.mockReset()
    repositoryRateLimitGuardMock.mockReturnValue({ blocked: false })
    noteRepositoryRateLimitSpendMock.mockReset()
    spendsSharedGitHubComQuotaMock.mockReset()
    spendsSharedGitHubComQuotaMock.mockImplementation(
      (repository?: { host?: string } | null, options?: { wslDistro?: string }) =>
        (!repository?.host || repository.host.toLowerCase() === 'github.com') && !options?.wslDistro
    )
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    _resetOwnerRepoCache()
  })

  it('queries GitHub rollup details with one cached GraphQL call', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: graphQLChecksResponse({
        contexts: [
          graphQLCheckRun({
            databaseId: 88,
            name: 'build',
            detailsUrl: 'https://github.com/acme/widgets/actions/runs/1'
          })
        ]
      }).stdout
    })

    const checks = await getPRChecks('/repo-root', 42, 'head-oid')

    expectGraphQLRollupCall()
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(checks).toEqual([
      {
        name: 'build',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/acme/widgets/actions/runs/1',
        checkRunId: 88,
        workflowRunId: 1
      }
    ])
  })

  it('merges rollup check-runs with legacy commit status contexts', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce(
      graphQLChecksResponse({
        contexts: [
          graphQLCheckRun({
            databaseId: 88,
            name: 'Summary',
            detailsUrl: 'https://github.com/acme/widgets/actions/runs/88',
            workflowRunId: 88
          }),
          graphQLStatusContext(),
          graphQLStatusContext({
            context: 'Summary',
            state: 'SUCCESS',
            targetUrl: 'https://example.com/duplicate-summary'
          })
        ]
      })
    )

    const checks = await getPRChecks('/repo-root', 42, 'head-oid')

    expectGraphQLRollupCall()
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(checks).toEqual([
      {
        name: 'Summary',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/acme/widgets/actions/runs/88',
        checkRunId: 88,
        workflowRunId: 88
      },
      {
        name: 'continuous-integration/jenkins/pr-merge',
        status: 'queued',
        conclusion: 'pending',
        url: 'https://jenkins.example.com/job/merge/1'
      }
    ])
  })

  it('surfaces an action_required check suite that has no check run', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce(
      graphQLChecksResponse({
        contexts: [
          graphQLCheckRun({
            name: 'track-community-pr',
            databaseId: 66,
            checkSuiteId: 1000,
            detailsUrl: 'https://github.com/acme/widgets/actions/runs/1'
          })
        ],
        checkSuites: [
          graphQLCheckSuite({ databaseId: 1000, conclusion: 'SUCCESS' }),
          graphQLCheckSuite({ databaseId: 1001 }),
          graphQLCheckSuite({ databaseId: 1002 })
        ]
      })
    )

    const checks = await getPRChecks('/repo-root', 42, 'head-oid')

    expectGraphQLRollupCall()
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(checks).toEqual([
      {
        name: 'track-community-pr',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/acme/widgets/actions/runs/1',
        checkRunId: 66,
        workflowRunId: 1
      },
      {
        name: 'GitHub Actions #1001',
        status: 'completed',
        conclusion: 'action_required',
        url: 'https://github.com/acme/widgets/commit/head-oid/checks?check_suite_id=1001'
      },
      {
        name: 'GitHub Actions #1002',
        status: 'completed',
        conclusion: 'action_required',
        url: 'https://github.com/acme/widgets/commit/head-oid/checks?check_suite_id=1002'
      }
    ])
  })

  it('maps stale and startup_failure conclusions to failure and action_required to its own state', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce(
      graphQLChecksResponse({
        contexts: [
          graphQLCheckRun({ name: 'needs-approval', conclusion: 'ACTION_REQUIRED' }),
          graphQLCheckRun({ name: 'old-run', conclusion: 'STALE' }),
          graphQLCheckRun({ name: 'boot', conclusion: 'STARTUP_FAILURE' })
        ]
      })
    )

    const checks = await getPRChecks('/repo-root', 42, 'head-oid')

    expect(checks.map((check) => check.conclusion)).toEqual([
      'action_required',
      'failure',
      'failure'
    ])
  })

  it('surfaces an action_required suite even when there are zero check runs', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce(
      graphQLChecksResponse({
        checkSuites: [graphQLCheckSuite({ databaseId: 1001 })]
      })
    )

    const checks = await getPRChecks('/repo-root', 42, 'head-oid')

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(checks).toEqual([
      {
        name: 'GitHub Actions #1001',
        status: 'completed',
        conclusion: 'action_required',
        url: 'https://github.com/acme/widgets/commit/head-oid/checks?check_suite_id=1001'
      }
    ])
  })

  it('returns an empty list when the rollup has no checks or pending suites', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce(graphQLChecksResponse())

    const checks = await getPRChecks('/repo-root', 42, 'head-oid')

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(checks).toEqual([])
  })

  it('uses REST fallback when the GraphQL rollup is unavailable', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('GraphQL rollup failed'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          check_runs: [
            {
              id: 88,
              name: 'Summary',
              status: 'completed',
              conclusion: 'success',
              html_url: 'https://github.com/acme/widgets/actions/runs/88',
              details_url: null
            }
          ]
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          statuses: [
            {
              context: 'continuous-integration/jenkins/pr-merge',
              state: 'pending',
              target_url: 'https://jenkins.example.com/job/merge/1'
            }
          ]
        })
      })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ check_suites: [] }) })

    const checks = await getPRChecks('/repo-root', 42, 'head-oid')

    expectGraphQLRollupCall()
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['api', '--cache', '60s', 'repos/acme/widgets/commits/head-oid/check-runs?per_page=100'],
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['api', '--cache', '60s', 'repos/acme/widgets/commits/head-oid/status?per_page=100'],
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(checks).toEqual([
      {
        name: 'Summary',
        status: 'completed',
        conclusion: 'success',
        url: 'https://github.com/acme/widgets/actions/runs/88',
        checkRunId: 88,
        workflowRunId: 88
      },
      {
        name: 'continuous-integration/jenkins/pr-merge',
        status: 'queued',
        conclusion: 'pending',
        url: 'https://jenkins.example.com/job/merge/1'
      }
    ])
  })

  it('treats gh pr checks "no checks reported" as an empty fallback list', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('GraphQL rollup failed'))
      .mockRejectedValueOnce(
        Object.assign(new Error('Command failed: gh pr checks 42'), {
          stderr: "no checks reported on the 'codex/keybindings-toml' branch\n",
          stdout: ''
        })
      )

    const checks = await getPRChecks('/repo-root', 42)

    expect(checks).toEqual([])
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'getPRChecks via GraphQL rollup failed, falling back to gh pr checks:',
      expect.any(Error)
    )
    consoleWarnSpy.mockRestore()
  })

  it('throws unexpected gh pr checks fallback failures so callers preserve cache', async () => {
    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('GraphQL rollup failed'))
      .mockRejectedValueOnce(
        Object.assign(new Error('Command failed: gh pr checks 42'), {
          stderr: 'GraphQL: Could not resolve to a PullRequest',
          stdout: ''
        })
      )

    await expect(getPRChecks('/repo-root', 42)).rejects.toThrow('Command failed: gh pr checks 42')
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'getPRChecks via GraphQL rollup failed, falling back to gh pr checks:',
      expect.any(Error)
    )
    expect(consoleWarnSpy).toHaveBeenCalledWith('getPRChecks failed:', expect.any(Error))
    consoleWarnSpy.mockRestore()
  })

  it('falls back to gh pr checks when GraphQL and REST details are unavailable', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('GraphQL rollup failed'))
      .mockRejectedValueOnce(new Error('REST details failed'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ name: 'lint', state: 'PASS', link: 'https://example.com/lint' }])
      })

    const checks = await getPRChecks('/repo-root', 42, 'stale-head')

    expectGraphQLRollupCall()
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['pr', 'checks', '42', '--json', 'name,state,link', '--repo', 'acme/widgets'],
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(checks).toEqual([
      {
        name: 'lint',
        status: 'completed',
        conclusion: 'success',
        url: 'https://example.com/lint',
        workflowRunId: undefined
      }
    ])
  })

  it('reruns GitHub Actions checks for a PR', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce(
        graphQLChecksResponse({
          contexts: [
            graphQLCheckRun({
              name: 'lint',
              conclusion: 'FAILURE',
              detailsUrl: 'https://github.com/acme/widgets/actions/runs/77/job/88',
              workflowRunId: 77
            })
          ]
        })
      )
      .mockResolvedValueOnce({ stdout: '' })

    const result = await rerunPRChecks('/repo-root', 42, { failedOnly: true })

    expect(result).toEqual({ ok: true, count: 1 })
    expectGraphQLRollupCall(1, true)
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['api', '-X', 'POST', 'repos/acme/widgets/actions/runs/77/rerun-failed-jobs'],
      {
        cwd: '/repo-root',
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
        host: 'github.com'
      }
    )
  })

  it('routes local WSL check retrieval and reruns through the selected distro', async () => {
    const localGitOptions = { wslDistro: 'Ubuntu' }
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce(
        graphQLChecksResponse({
          contexts: [
            graphQLCheckRun({
              name: 'build',
              detailsUrl: 'https://github.com/acme/widgets/actions/runs/66',
              workflowRunId: 66
            })
          ]
        })
      )
      .mockResolvedValueOnce(
        graphQLChecksResponse({
          contexts: [
            graphQLCheckRun({
              name: 'lint',
              conclusion: 'FAILURE',
              detailsUrl: 'https://github.com/acme/widgets/actions/runs/77/job/88',
              workflowRunId: 77
            })
          ]
        })
      )
      .mockResolvedValueOnce({ stdout: '' })

    await getPRChecks('/repo-root', 42, 'head-oid', undefined, undefined, null, localGitOptions)
    await rerunPRChecks('/repo-root', 42, { failedOnly: true }, null, localGitOptions)

    expect(getOwnerRepoMock).toHaveBeenCalledWith('/repo-root', null, localGitOptions)
    expect(ghExecFileAsyncMock.mock.calls.every((call) => call[1]?.wslDistro === 'Ubuntu')).toBe(
      true
    )
    expect(ghExecFileAsyncMock).toHaveBeenLastCalledWith(
      ['api', '-X', 'POST', 'repos/acme/widgets/actions/runs/77/rerun-failed-jobs'],
      expect.objectContaining({
        cwd: '/repo-root',
        wslDistro: 'Ubuntu',
        env: expect.objectContaining({ GH_PROMPT_DISABLED: '1' })
      })
    )
    expect(getRateLimitMock).not.toHaveBeenCalled()
    expect(repositoryRateLimitGuardMock).toHaveBeenCalledWith(
      { owner: 'acme', repo: 'widgets', host: 'github.com' },
      'graphql',
      expect.objectContaining({ cwd: '/repo-root', wslDistro: 'Ubuntu', host: 'github.com' })
    )
  })

  it('uses explicit PR repo for rollup and gh pr checks fallback', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('GraphQL rollup failed'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ name: 'lint', state: 'PASS', link: 'https://example.com/lint' }])
      })

    await getPRChecks('/repo-root', 42, undefined, {
      owner: 'acme',
      repo: 'widgets',
      host: 'github.com'
    })

    expect(getOwnerRepoMock).not.toHaveBeenCalled()
    expectGraphQLRollupCall()
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['pr', 'checks', '42', '--json', 'name,state,link', '--repo', 'acme/widgets'],
      { cwd: '/repo-root', host: 'github.com' }
    )
  })

  it('throws when both GraphQL rollup and gh pr checks fail', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('GraphQL rollup failed'))
      .mockRejectedValueOnce(new Error('rate limited'))

    await expect(getPRChecks('/repo-root', 42)).rejects.toThrow('rate limited')
  })
})
