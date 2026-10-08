import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as repoExecution from '../../github-api-repository'
import * as gh from '../../gh-utils'
import * as rateLimit from '../../rate-limit'
import { listActionsRuns, listActionsWorkflows } from './list-actions-pages'
import { getWorkflowRunDetails } from './get-workflow-run-details'
import { prCheckLogTailCache } from '../check/check-job-log-tails'
import { mapActionsRun } from './workflow-run-field-mapping'

const repository = { owner: 'acme', repo: 'widget', host: 'github.company.test' }
const run = {
  id: 9,
  workflow_id: 5,
  run_number: 7,
  run_attempt: 2,
  name: 'Build',
  display_title: 'Ship widgets',
  status: 'in_progress',
  updated_at: '2026-09-30T01:00:00Z'
}
const exec = vi.spyOn(gh, 'ghExecFileAsync')
beforeEach(() => {
  vi.spyOn(repoExecution, 'resolveGitHubRepoExecution').mockResolvedValue({
    ownerRepo: repository,
    ghOptions: { host: repository.host }
  })
  vi.spyOn(gh, 'acquire').mockResolvedValue(undefined)
  vi.spyOn(gh, 'release').mockImplementation(() => {})
  vi.spyOn(rateLimit, 'repositoryRateLimitGuard').mockReturnValue({ blocked: false })
  exec.mockReset()
  prCheckLogTailCache.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
})
function json(value: unknown) {
  return { stdout: JSON.stringify(value), stderr: '' }
}

describe('bounded repository Actions reads', () => {
  it('isolates successful and unavailable excerpts by account and native/WSL owner', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const jobs = [{ id: 1, name: 'Build', conclusion: 'failure' }]
    let logCalls = 0
    vi.spyOn(gh, 'ghExecFileAsync').mockImplementation(async (args) => {
      if (args[1]?.endsWith('/logs')) {
        logCalls += 1
        if (logCalls === 1) {
          throw new Error('Owner A cannot read logs')
        }
        return { stdout: `owner excerpt ${logCalls}`, stderr: '' }
      }
      return json(args[1]?.includes('/jobs?') ? { jobs, total_count: 1 } : run)
    })
    const resolve = vi.spyOn(repoExecution, 'resolveGitHubRepoExecution')
    const read = async (user: string, wslDistro?: string) => {
      resolve.mockResolvedValue({
        ownerRepo: repository,
        ghOptions: { ghAccount: { host: repository.host, user }, wslDistro }
      })
      return getWorkflowRunDetails('/repo', { repository, runId: 9 })
    }
    expect((await read('a')).jobs[0].logTail).toBeNull()
    expect((await read('b')).jobs[0].logTail).toContain('owner excerpt 2')
    expect((await read('b', 'Ubuntu')).jobs[0].logTail).toContain('owner excerpt 3')
    expect((await read('b', 'Debian')).jobs[0].logTail).toContain('owner excerpt 4')
    expect((await read('b')).jobs[0].logTail).toContain('owner excerpt 2')
    expect((await read('a')).jobs[0].logTail).toBeNull()
    expect(logCalls).toBe(4)
  })
  it('queries the whole repository without a PR and preserves Enterprise execution options', async () => {
    const command = vi
      .spyOn(gh, 'ghExecFileAsync')
      .mockResolvedValue(json({ total_count: 2000, workflow_runs: [run] }))
    const page = await listActionsRuns(
      '/remote/repo',
      { page: 20, branch: 'topic & release', status: 'failure' },
      'ssh-host',
      { wslDistro: 'Ubuntu' }
    )
    expect(command).toHaveBeenCalledWith(
      [
        'api',
        'repos/acme/widget/actions/runs?per_page=50&page=20&branch=topic+%26+release&status=failure'
      ],
      expect.objectContaining({ host: repository.host, signal: expect.any(AbortSignal) })
    )
    expect(repoExecution.resolveGitHubRepoExecution).toHaveBeenCalledWith(
      '/remote/repo',
      expect.any(Function),
      'ssh-host',
      { wslDistro: 'Ubuntu' }
    )
    expect(page).toMatchObject({ hasNextPage: false, limitReached: true, repository })
  })
  it('requires verified origin discovery and propagates unavailable SSH errors', async () => {
    const command = vi.spyOn(gh, 'ghExecFileAsync')
    vi.spyOn(repoExecution, 'getGitHubApiRepositoryForRemote').mockRejectedValue(
      new Error('SSH Git provider unavailable')
    )
    vi.spyOn(repoExecution, 'resolveGitHubRepoExecution').mockImplementation(
      async (_path, resolution) => ({
        ownerRepo: typeof resolution === 'function' ? await resolution() : null,
        ghOptions: {}
      })
    )
    await expect(listActionsRuns('/remote/repo', {}, 'ssh-host')).rejects.toThrow(
      'SSH Git provider unavailable'
    )
    expect(repoExecution.getGitHubApiRepositoryForRemote).toHaveBeenCalledWith(
      '/remote/repo',
      'origin',
      'ssh-host',
      {},
      { requireVerifiedSshProbe: true }
    )
    expect(command).not.toHaveBeenCalled()
  })
  it('encodes workflow scope and preserves future status values', async () => {
    const command = vi
      .spyOn(gh, 'ghExecFileAsync')
      .mockResolvedValue(json({ workflow_runs: [{ ...run, status: 'future_state' }] }))
    const page = await listActionsRuns('/repo', { workflowId: 5 })
    expect(command.mock.calls[0][0]).toEqual([
      'api',
      'repos/acme/widget/actions/workflows/5/runs?per_page=50&page=1'
    ])
    expect(page.items[0].status).toBe('future_state')
  })
  it('does not convert API errors into an empty successful list', async () => {
    vi.spyOn(gh, 'ghExecFileAsync').mockRejectedValue(
      new Error('HTTP 403 SSO authorization required')
    )
    await expect(listActionsRuns('/repo', {})).rejects.toThrow('SSO')
  })
  it('bounds pages and IDs before invoking execution', async () => {
    expect(() => listActionsRuns('/repo', { page: 21 })).toThrow()
    expect(() => listActionsRuns('/repo', { workflowId: -1 })).toThrow()
    expect(() => listActionsWorkflows('/repo', { page: 11 })).toThrow()
    expect(() => getWorkflowRunDetails('/repo', { repository, runId: 9, jobsPage: 11 })).toThrow()
    expect(repoExecution.resolveGitHubRepoExecution).not.toHaveBeenCalled()
  })
  it('keeps jobs failures visibly partial and metadata failures fatal', async () => {
    const command = vi
      .spyOn(gh, 'ghExecFileAsync')
      .mockResolvedValueOnce(json(run))
      .mockRejectedValueOnce(new Error('jobs unavailable'))
    const details = await getWorkflowRunDetails('/repo', { repository, runId: 9 })
    expect(details.actions.jobsError).toBe('jobs unavailable')
    expect(details.status).toBe('in_progress')
    expect(details.completedAt).toBeNull()
    command.mockRejectedValueOnce(new Error('metadata unavailable'))
    await expect(getWorkflowRunDetails('/repo', { repository, runId: 9 })).rejects.toThrow(
      'metadata unavailable'
    )
  })
  it('resets paginated jobs on attempt changes and never narrows by workflow name', async () => {
    const command = vi
      .spyOn(gh, 'ghExecFileAsync')
      .mockResolvedValueOnce(json(run))
      .mockResolvedValueOnce(
        json({
          total_count: 101,
          jobs: [
            { id: 1, name: 'Build', conclusion: 'success' },
            { id: 2, name: 'Deploy', status: 'queued' }
          ]
        })
      )
    const details = await getWorkflowRunDetails('/repo', {
      repository,
      runId: 9,
      jobsPage: 2,
      expectedAttempt: 1
    })
    expect(command.mock.calls[1][0]).toEqual([
      'api',
      'repos/acme/widget/actions/runs/9/attempts/2/jobs?per_page=100&page=1'
    ])
    expect(details.jobs.map((job) => job.name)).toEqual(['Build', 'Deploy'])
    expect(details.actions).toMatchObject({ jobsPage: 1, hasNextPage: true })
  })
  it('limits failed-log requests to five and retries unavailable excerpts on refresh', async () => {
    const jobs = Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      name: `Failed ${index}`,
      conclusion: 'failure'
    }))
    const command = vi.spyOn(gh, 'ghExecFileAsync').mockImplementation(async (args) => {
      const endpoint = args[1] ?? ''
      if (endpoint.endsWith('/logs')) {
        throw new Error('expired log')
      }
      return json(endpoint.includes('/jobs?') ? { jobs, total_count: 6 } : run)
    })
    const first = await getWorkflowRunDetails('/repo', { repository, runId: 9 })
    expect(first.actions.logWarnings).toHaveLength(5)
    expect(command.mock.calls.filter(([args]) => args[1]?.endsWith('/logs'))).toHaveLength(5)
    await getWorkflowRunDetails('/repo', { repository, runId: 9, noCache: true })
    expect(command.mock.calls.filter(([args]) => args[1]?.endsWith('/logs'))).toHaveLength(10)
  })
  it('rejects malformed required data and unsafe GitHub URLs', () => {
    expect(() => mapActionsRun({ ...run, id: '9' })).toThrow()
    expect(mapActionsRun({ ...run, html_url: 'javascript:alert(1)' }).htmlUrl).toBeNull()
  })
})
