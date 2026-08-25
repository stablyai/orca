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
import { rethrowCheckDetailsAbort, waitForCheckDetailsResolution } from './check-details-abort'
import { attachFailedJobLogTails } from './check-job-log-tails'
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
  const hostDeadline = setTimeout(() => {
    hostDeadlineExpired = true
    controller.abort(new Error(GITHUB_CHECK_DETAILS_TIMEOUT_MESSAGE))
  }, GITHUB_CHECK_DETAILS_HOST_TIMEOUT_MS)
  let acquired = false
  try {
    const resolved = await waitForCheckDetailsResolution(
      resolveGitHubRepoExecution(repoPath, args.prRepo, connectionId, localGitOptions),
      controller.signal
    )
    if (!resolved.ownerRepo) {
      return null
    }
    const ownerRepo = resolved.ownerRepo
    const ghOptions: GhExecOptions = { ...resolved.ghOptions, signal: controller.signal }
    await acquire(controller.signal)
    acquired = true
    let checkRun: Record<string, unknown> | null = null
    let annotations: PRCheckRunDetails['annotations'] = []
    if (args.checkRunId) {
      const { stdout } = await ghExecFileAsync(
        ['api', `repos/${ownerRepo.owner}/${ownerRepo.repo}/check-runs/${args.checkRunId}`],
        ghOptions
      )
      checkRun = JSON.parse(stdout) as Record<string, unknown>
      try {
        const annotationsResult = await ghExecFileAsync(
          [
            'api',
            `repos/${ownerRepo.owner}/${ownerRepo.repo}/check-runs/${args.checkRunId}/annotations?per_page=20`
          ],
          ghOptions
        )
        annotations = mapCheckAnnotations(JSON.parse(annotationsResult.stdout))
      } catch (err) {
        rethrowCheckDetailsAbort(controller.signal, err)
        console.warn('getPRCheckDetails annotations fetch failed:', err)
      }
    }

    const workflowRunId = args.workflowRunId ?? getWorkflowRunIdFromCheckRun(checkRun)
    let jobs: PRCheckRunDetails['jobs'] = []
    if (workflowRunId) {
      try {
        const { stdout } = await ghExecFileAsync(
          [
            'api',
            `repos/${ownerRepo.owner}/${ownerRepo.repo}/actions/runs/${workflowRunId}/jobs?per_page=100`
          ],
          ghOptions
        )
        jobs = mapWorkflowJobs(JSON.parse(stdout), args.checkName)
        await attachFailedJobLogTails(jobs, ownerRepo, ghOptions)
      } catch (err) {
        rethrowCheckDetailsAbort(controller.signal, err)
        console.warn('getPRCheckDetails workflow jobs fetch failed:', err)
      }
    }

    const output =
      checkRun?.output && typeof checkRun.output === 'object'
        ? (checkRun.output as Record<string, unknown>)
        : null
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
  } catch (err) {
    console.warn('getPRCheckDetails failed:', err)
    if (hostDeadlineExpired && !callerSignal?.aborted) {
      throw new Error(GITHUB_CHECK_DETAILS_TIMEOUT_MESSAGE)
    }
    throw err
  } finally {
    clearTimeout(hostDeadline)
    callerSignal?.removeEventListener('abort', forwardCallerAbort)
    if (acquired) {
      release()
    }
  }
}
