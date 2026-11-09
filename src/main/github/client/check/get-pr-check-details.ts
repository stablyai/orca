import type { PRCheckRunDetails } from '../../../../shared/github/check-types'
import { ghExecFileAsync, acquire, release, type LocalGitExecOptions } from '../../gh-utils'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
import {
  GITHUB_CHECK_DETAILS_HOST_TIMEOUT_MS,
  GITHUB_CHECK_DETAILS_TIMEOUT_MESSAGE
} from '../../../../shared/github/check-details-deadline'
import type { GhExecOptions } from './../github-exec-scope'
import {
  nullableString,
  mapCheckAnnotations,
  mapWorkflowJobs,
  getWorkflowRunIdFromCheckRun
} from './check-detail-field-mapping'
import {
  createCheckDetailsAbortError,
  rethrowCheckDetailsAbort,
  waitForCheckDetailsResolution
} from './check-details-abort'
import { attachFailedJobLogTails } from './check-job-log-tails'
import {
  createCheckDetailsAdmissionLifetime,
  runCheckDetailsCall
} from './check-details-admission-lifetime'
import { snapshotCheckJobLogExecution } from './check-job-log-execution'
export async function getPRCheckDetails(
  repoPath: string,
  args: {
    checkRunId?: number
    workflowRunId?: number
    checkName?: string
    url?: string | null
    prRepo?: GitHubApiRepository | null
  },
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  callerSignal?: AbortSignal
): Promise<PRCheckRunDetails | null> {
  const controller = new AbortController()
  let hostDeadlineExpired = false
  const forwardCallerAbort = (): void => controller.abort(callerSignal?.reason)
  if (callerSignal?.aborted) {
    forwardCallerAbort()
  } else {
    callerSignal?.addEventListener('abort', forwardCallerAbort, { once: true })
  }
  const deadlineAt = Date.now() + GITHUB_CHECK_DETAILS_HOST_TIMEOUT_MS
  const hostDeadline = setTimeout(() => {
    hostDeadlineExpired = true
    controller.abort(new Error(GITHUB_CHECK_DETAILS_TIMEOUT_MESSAGE))
  }, GITHUB_CHECK_DETAILS_HOST_TIMEOUT_MS)
  let admission: ReturnType<typeof createCheckDetailsAdmissionLifetime> | undefined
  try {
    const resolved = await waitForCheckDetailsResolution(
      resolveGitHubRepoExecution(repoPath, args.prRepo, connectionId, localGitOptions),
      controller.signal
    )
    if (!resolved.ownerRepo) {
      return null
    }
    const ownerRepo = resolved.ownerRepo
    const snapshot = snapshotCheckJobLogExecution(ownerRepo, resolved.ghOptions)
    const ghOptions: GhExecOptions = { ...snapshot.ghOptions, signal: controller.signal }
    await acquire(controller.signal)
    admission = createCheckDetailsAdmissionLifetime(release)
    const retainUntil = admission.retainUntil
    let previous: Promise<void> = Promise.resolve()
    const waitPrevious = (): Promise<void> =>
      waitForCheckDetailsResolution(previous, controller.signal)
    const fetchMetadata = async (argv: string[]): Promise<{ stdout: string; stderr: string }> => {
      await waitPrevious()
      const call = runCheckDetailsCall(
        (hooks) => ghExecFileAsync(argv, ghOptions, hooks),
        controller.signal,
        retainUntil
      )
      previous = call.terminated
      return call.result
    }
    let checkRun: Record<string, unknown> | null = null
    let output: Record<string, unknown> | null = null
    let annotations: PRCheckRunDetails['annotations'] = []
    if (args.checkRunId) {
      const { stdout } = await fetchMetadata([
        'api',
        `repos/${ownerRepo.owner}/${ownerRepo.repo}/check-runs/${args.checkRunId}`
      ])
      const parsed: unknown = JSON.parse(stdout)
      checkRun =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? Object.fromEntries(Object.entries(parsed))
          : null
      output =
        checkRun?.output && typeof checkRun.output === 'object'
          ? Object.fromEntries(Object.entries(checkRun.output))
          : null
      if (checkRun?.status !== 'completed' || output?.annotations_count !== 0) {
        try {
          const annotationsResult = await fetchMetadata([
            'api',
            `repos/${ownerRepo.owner}/${ownerRepo.repo}/check-runs/${args.checkRunId}/annotations?per_page=20`
          ])
          annotations = mapCheckAnnotations(JSON.parse(annotationsResult.stdout))
        } catch (err) {
          rethrowCheckDetailsAbort(controller.signal, err)
          console.warn('getPRCheckDetails', 'annotations_failed')
        }
      }
      await waitPrevious()
    }

    const workflowRunId = args.workflowRunId ?? getWorkflowRunIdFromCheckRun(checkRun)
    let jobs: PRCheckRunDetails['jobs'] = []
    if (workflowRunId) {
      try {
        const { stdout } = await fetchMetadata([
          'api',
          `repos/${ownerRepo.owner}/${ownerRepo.repo}/actions/runs/${workflowRunId}/jobs?per_page=100`
        ])
        jobs = mapWorkflowJobs(JSON.parse(stdout), args.checkName)
        await waitPrevious()
        await attachFailedJobLogTails(jobs, ownerRepo, ghOptions, {
          deadlineAt,
          executionScope: snapshot.executionScope,
          retainUntil
        })
      } catch (err) {
        rethrowCheckDetailsAbort(controller.signal, err)
        console.warn('getPRCheckDetails', 'workflow_jobs_failed')
      }
      await waitPrevious()
    }

    return {
      name: nullableString(checkRun?.name) ?? args.checkName ?? 'Check',
      status: nullableString(checkRun?.status),
      conclusion: nullableString(checkRun?.conclusion),
      url: nullableString(checkRun?.html_url) ?? args.url ?? null,
      detailsUrl: nullableString(checkRun?.details_url) ?? args.url ?? null,
      startedAt: nullableString(checkRun?.started_at),
      completedAt: nullableString(checkRun?.completed_at),
      title: nullableString(output?.title),
      summary: nullableString(output?.summary),
      text: nullableString(output?.text),
      annotations,
      jobs
    }
  } catch {
    console.warn(
      'getPRCheckDetails',
      hostDeadlineExpired ? 'deadline' : callerSignal?.aborted ? 'cancelled' : 'request_failed'
    )
    if (hostDeadlineExpired && !callerSignal?.aborted) {
      throw new Error(GITHUB_CHECK_DETAILS_TIMEOUT_MESSAGE)
    }
    if (callerSignal?.aborted) {
      throw createCheckDetailsAbortError()
    }
    throw new Error('Could not load check details.')
  } finally {
    clearTimeout(hostDeadline)
    callerSignal?.removeEventListener('abort', forwardCallerAbort)
    admission?.finish()
  }
}
