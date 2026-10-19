import type { PRCheckJob } from '../../../../shared/github/check-types'
import type { GitHubApiRepository } from '../../github-api-repository'
import type { GhExecOptions } from '../github-exec-scope'
import { snapshotCheckJobLogExecution } from './check-job-log-execution'
import { attachFailedJobLogTails } from './check-job-log-tails'
export const checkLogRepo = { owner: 'acme', repo: 'widgets' }
export function failedLogJob(id = 77, overrides: Partial<PRCheckJob> = {}): PRCheckJob {
  return {
    id,
    name: `job ${id}`,
    status: 'completed',
    conclusion: 'failure',
    startedAt: 'start',
    completedAt: 'done',
    url: `https://github.com/acme/widgets/actions/jobs/${id}`,
    logTail: null,
    steps: [],
    ...overrides
  }
}
export function attachLogFixture(
  jobs: PRCheckJob[],
  {
    controller = new AbortController(),
    deadlineAt = Date.now() + 25_000,
    options = { cwd: '/folder', env: { GH_TOKEN: 'fixture-token' } },
    repo = checkLogRepo,
    retainUntil = (_terminated: Promise<void>): void => {}
  }: {
    controller?: AbortController
    deadlineAt?: number
    options?: GhExecOptions
    repo?: GitHubApiRepository
    retainUntil?: (terminated: Promise<void>) => void
  } = {}
): Promise<void> {
  const snapshot = snapshotCheckJobLogExecution(repo, options)
  return attachFailedJobLogTails(
    jobs,
    repo,
    { ...snapshot.ghOptions, signal: controller.signal },
    {
      deadlineAt,
      executionScope: snapshot.executionScope,
      retainUntil
    }
  )
}
