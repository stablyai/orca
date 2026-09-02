import type { GitHubRerunPRChecksResult } from '../../../../shared/github/check-types'
import { ghExecFileAsync, acquire, release, type LocalGitExecOptions } from '../../gh-utils'
// Why: pure error helpers come from their own modules so tests that mock gh-utils still classify for real.
import { extractExecError } from '../../../git/exec-error'
import { classifyRerunChecksError } from '../../gh-error-classification'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
import { getPRChecks } from './get-pr-checks'
import { parseActionsRunId } from './check-detail-field-mapping'
export async function rerunPRChecks(
  repoPath: string,
  prNumber: number,
  options: {
    headSha?: string
    failedOnly?: boolean
    prRepo?: GitHubApiRepository | null
  } = {},
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubRerunPRChecksResult> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    options.prRepo,
    connectionId,
    localGitOptions
  )
  if (!ownerRepo) {
    return { ok: false, error: 'Could not resolve GitHub owner/repo for this repository' }
  }

  const checks = await getPRChecks(
    repoPath,
    prNumber,
    options.headSha,
    ownerRepo,
    { noCache: true },
    connectionId,
    localGitOptions
  )
  const candidates = options.failedOnly
    ? checks.filter((check) =>
        ['failure', 'cancelled', 'timed_out'].includes(check.conclusion ?? '')
      )
    : checks
  const workflowRunIds = new Set(
    candidates
      .map((check) => check.workflowRunId ?? parseActionsRunId(check.url))
      .filter((id): id is number => typeof id === 'number')
  )
  const checkRunIds = new Set(
    candidates
      .filter((check) => !check.workflowRunId && !parseActionsRunId(check.url))
      .map((check) => check.checkRunId)
      .filter((id): id is number => typeof id === 'number')
  )

  if (workflowRunIds.size === 0 && checkRunIds.size === 0) {
    return {
      ok: false,
      error: options.failedOnly
        ? 'No failed GitHub Actions checks to rerun.'
        : 'No rerunnable checks found.'
    }
  }

  let count = 0
  await acquire()
  try {
    for (const runId of workflowRunIds) {
      const endpoint = options.failedOnly
        ? `repos/${ownerRepo.owner}/${ownerRepo.repo}/actions/runs/${runId}/rerun-failed-jobs`
        : `repos/${ownerRepo.owner}/${ownerRepo.repo}/actions/runs/${runId}/rerun`
      await ghExecFileAsync(['api', '-X', 'POST', endpoint], {
        ...ghOptions,
        env: { ...process.env, GH_PROMPT_DISABLED: '1' }
      })
      count += 1
    }
    for (const checkRunId of checkRunIds) {
      await ghExecFileAsync(
        [
          'api',
          '-X',
          'POST',
          `repos/${ownerRepo.owner}/${ownerRepo.repo}/check-runs/${checkRunId}/rerequest`
        ],
        { ...ghOptions, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }
      )
      count += 1
    }
    return { ok: true, count }
  } catch (err) {
    const { stderr } = extractExecError(err)
    const classified = classifyRerunChecksError(stderr).message
    // Why: these POSTs are not idempotent — say how many reruns already started so a retry isn't blind.
    return {
      ok: false,
      error:
        count > 0
          ? `${classified} (${count} rerun${count === 1 ? '' : 's'} already started)`
          : classified
    }
  } finally {
    release()
  }
}
