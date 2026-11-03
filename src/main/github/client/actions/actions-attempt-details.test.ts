import '../../../runtime/rpc/unused-default-rpc-methods.test-fixture'
import { RpcDispatcher } from '../../../runtime/rpc/dispatcher'
import { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import { GITHUB_ACTIONS_METHODS } from '../../../runtime/rpc/methods/github-actions-methods'
import type { RpcResponse } from '../../../runtime/rpc/core'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as execution from '../../github-api-repository'
import * as gh from '../../gh-utils'
import * as limits from '../../rate-limit'
import { getWorkflowRunDetails } from './get-workflow-run-details'

const repository = { owner: 'acme', repo: 'widgets', host: 'github.com' }
const sha = 'a'.repeat(40)
const run = {
  id: 9,
  workflow_id: 5,
  run_number: 7,
  run_attempt: 3,
  status: 'completed',
  conclusion: 'success'
}
const selected = {
  ...run,
  run_attempt: 1,
  conclusion: 'failure',
  head_sha: sha,
  pull_requests: [
    {
      number: 42,
      url: 'https://api.github.com/repos/acme/widgets/pulls/42',
      head: { sha: 'b'.repeat(40) }
    }
  ]
}
const calls = vi.fn<typeof gh.ghExecFileAsync>()
const base = 'repos/acme/widgets/actions/runs/9'
let responses: Map<string, unknown>
beforeEach(() => {
  vi.spyOn(execution, 'resolveGitHubRepoExecution').mockResolvedValue({
    ownerRepo: repository,
    ghOptions: {}
  })
  vi.spyOn(gh, 'acquire').mockResolvedValue(undefined)
  vi.spyOn(gh, 'release').mockImplementation(() => {})
  vi.spyOn(limits, 'repositoryRateLimitGuard').mockReturnValue({ blocked: false })
  responses = new Map<string, unknown>([
    [base, run],
    [`${base}/attempts/1`, selected],
    [`${base}/attempts/1/jobs?per_page=100&page=1`, { total_count: 0, jobs: [] }],
    [
      `repos/acme/widgets/commits/${sha}`,
      { sha, html_url: `https://github.com/acme/widgets/commit/${sha}` }
    ],
    [
      'repos/acme/widgets/pulls/42',
      { number: 42, html_url: 'https://github.com/acme/widgets/pull/42' }
    ]
  ])
  calls.mockReset().mockImplementation(async (args) => {
    const value = responses.get(args[1])
    if (value instanceof Error) {
      throw value
    }
    if (!value) {
      throw new Error(`Unexpected endpoint: ${args[1]}`)
    }
    return { stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' }
  })
  vi.spyOn(gh, 'ghExecFileAsync').mockImplementation(calls)
})
afterEach(() => vi.restoreAllMocks())

it('loads the selected attempt and its jobs, explicit commit/PR links and runner metadata', async () => {
  responses.set(`${base}/attempts/1/jobs?per_page=100&page=1`, {
    total_count: 1,
    jobs: [
      {
        id: 12,
        name: 'Build',
        status: 'completed',
        conclusion: 'failure',
        labels: ['self-hosted', 'linux', 8, 'linux'],
        runner_name: 'runner-one',
        steps: [{ name: 'Compile', status: 'completed', conclusion: 'failure' }]
      }
    ]
  })
  responses.set('repos/acme/widgets/actions/jobs/12/logs', 'Compile failed')
  const details = await getWorkflowRunDetails('/repo', { repository, runId: 9, attempt: 1 })
  expect(details.actions).toMatchObject({
    latestAttempt: 3,
    run: { runAttempt: 1, conclusion: 'failure', headSha: sha },
    commitUrl: `https://github.com/acme/widgets/commit/${sha}`,
    pullRequests: [{ number: 42, url: 'https://github.com/acme/widgets/pull/42' }]
  })
  expect(details.jobs[0]).toMatchObject({
    runnerName: 'runner-one',
    runnerLabels: ['self-hosted', 'linux'],
    status: 'completed',
    steps: [{ name: 'Compile', status: 'completed' }]
  })
  expect(calls.mock.calls.some(([args]) => args[1].includes('b'.repeat(40)))).toBe(false)
})

it('resets a mismatched pagination attempt but retains an explicitly selected old attempt', async () => {
  await getWorkflowRunDetails('/repo', {
    repository,
    runId: 9,
    attempt: 1,
    expectedAttempt: 2,
    jobsPage: 2
  })
  expect(
    calls.mock.calls.some(([args]) => args[1] === `${base}/attempts/1/jobs?per_page=100&page=1`)
  ).toBe(true)
  expect(calls.mock.calls.some(([args]) => args[1].includes('/attempts/3/jobs'))).toBe(false)
})

it.each([new Error('HTTP 403'), { ...selected, run_attempt: 2 }, { ...selected, id: 10 }])(
  'fails visibly instead of falling back to latest for an unavailable or wrong attempt',
  async (value) => {
    responses.set(`${base}/attempts/1`, value)
    await expect(
      getWorkflowRunDetails('/repo', { repository, runId: 9, attempt: 1 })
    ).rejects.toThrow()
    expect(calls.mock.calls.some(([args]) => args[1].includes('/jobs?'))).toBe(false)
  }
)

it('rejects a future attempt before requesting its metadata or jobs', async () => {
  await expect(
    getWorkflowRunDetails('/repo', { repository, runId: 9, attempt: 4 })
  ).rejects.toThrow('not available')
  expect(calls).toHaveBeenCalledTimes(1)
})

it('keeps available jobs when link permissions fail and never invents a link from a SHA', async () => {
  responses.set(`repos/acme/widgets/commits/${sha}`, new Error('HTTP 403'))
  responses.set('repos/acme/widgets/pulls/42', { number: 42, html_url: 'javascript:alert(1)' })
  const details = await getWorkflowRunDetails('/repo', { repository, runId: 9, attempt: 1 })
  expect(details.actions).toMatchObject({
    commitUrl: null,
    pullRequests: [],
    relatedLinksUnavailable: true,
    jobsError: null
  })
})

it('does not resolve a foreign PR number against the registered repository', async () => {
  responses.set(`${base}/attempts/1`, {
    ...selected,
    pull_requests: [{ number: 42, url: 'https://api.github.com/repos/other/private/pulls/42' }]
  })
  const details = await getWorkflowRunDetails('/repo', { repository, runId: 9, attempt: 1 })
  expect(details.actions.pullRequests).toEqual([])
  expect(calls.mock.calls.some(([args]) => args[1] === 'repos/acme/widgets/pulls/42')).toBe(false)
})

it.each([false, true])(
  'preserves the selected attempt through real RPC schema dispatch (streaming=%s)',
  async (streaming) => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'getRepoActionsRunDetails').mockImplementation((_repo, query, signal) =>
      getWorkflowRunDetails('/repo', query, undefined, {}, signal)
    )
    const dispatcher = new RpcDispatcher({ runtime, methods: GITHUB_ACTIONS_METHODS })
    const request = {
      id: 'attempt-read',
      authToken: 'token',
      method: 'github.actionsRunDetails',
      params: { repo: 'registered', repository, runId: 9, attempt: 1 }
    }
    const replies: RpcResponse[] = []
    const options = { callerScope: { kind: 'runtime-paired', grants: [] } } as const
    if (streaming) {
      await dispatcher.dispatchStreaming(request, (raw) => replies.push(JSON.parse(raw)), options)
    } else {
      replies.push(await dispatcher.dispatch(request, options))
    }
    expect(replies).toEqual([
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          actions: expect.objectContaining({
            run: expect.objectContaining({ runAttempt: 1 }),
            latestAttempt: 3
          })
        })
      })
    ])
  }
)

it('does not expose a commit URL when the returned SHA is not the execution SHA', async () => {
  responses.set(`repos/acme/widgets/commits/${sha}`, {
    sha: 'b'.repeat(40),
    html_url: 'https://github.com/acme/widgets/commit/wrong'
  })
  const details = await getWorkflowRunDetails('/repo', { repository, runId: 9, attempt: 1 })
  expect(details.actions.commitUrl).toBeNull()
  expect(details.actions.relatedLinksUnavailable).toBe(true)
})

it('does not repeat related-link reads when loading a further jobs page', async () => {
  responses.set(`${base}/attempts/1/jobs?per_page=100&page=2`, { total_count: 101, jobs: [] })
  const details = await getWorkflowRunDetails('/repo', {
    repository,
    runId: 9,
    attempt: 1,
    jobsPage: 2,
    expectedAttempt: 1
  })
  expect(details.actions.jobsPage).toBe(2)
  expect(
    calls.mock.calls.some(([args]) => args[1].includes('/commits/') || args[1].includes('/pulls/'))
  ).toBe(false)
})
