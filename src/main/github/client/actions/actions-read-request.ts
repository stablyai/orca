import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import { createCheckDetailsAdmissionLifetime } from '../check/check-details-admission-lifetime'
import { snapshotCheckJobLogExecution } from '../check/check-job-log-execution'
import type { CheckJobLogContext } from '../check/check-job-log-tails'
import { acquire, release, ghExecFileAsync, type LocalGitExecOptions } from '../../gh-utils'
import {
  getGitHubApiRepositoryForRemote,
  resolveGitHubRepoExecution,
  type GitHubApiRepository
} from '../../github-api-repository'
import type { GhExecOptions } from '../github-exec-scope'
import { repositoryRateLimitGuard } from '../../rate-limit'
import { waitForCheckDetailsResolution } from '../check/check-details-abort'
import {
  GITHUB_CHECK_DETAILS_HOST_TIMEOUT_MS,
  GITHUB_CHECK_DETAILS_TIMEOUT_MESSAGE
} from '../../../../shared/github/check-details-deadline'

/** Resolve the GitHub account and execution route, enforce a deadline including queue time, and release the read slot. */
export async function withActionsRead<T>(
  repoPath: string,
  repository: GitHubApiRepository | undefined,
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions,
  signal: AbortSignal | undefined,
  read: (
    repository: GitHubApiRepository,
    options: GhExecOptions,
    context: CheckJobLogContext
  ) => Promise<T>,
  deadline = {
    timeoutMs: GITHUB_CHECK_DETAILS_HOST_TIMEOUT_MS,
    message: GITHUB_CHECK_DETAILS_TIMEOUT_MESSAGE
  }
): Promise<T> {
  const controller = new AbortController()
  /** Forward caller cancellation to the queued or active GitHub read with its original reason. */
  const abort = (): void => controller.abort(signal?.reason)
  if (signal?.aborted) {
    abort()
  } else {
    signal?.addEventListener('abort', abort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(new Error(deadline.message)), deadline.timeoutMs)
  const deadlineAt = Date.now() + deadline.timeoutMs
  let admission: ReturnType<typeof createCheckDetailsAdmissionLifetime> | undefined
  try {
    const resolved = await waitForCheckDetailsResolution(
      resolveGitHubRepoExecution(
        repoPath,
        async () => {
          const origin = await getGitHubApiRepositoryForRemote(
            repoPath,
            'origin',
            connectionId,
            localGitOptions,
            { requireVerifiedSshProbe: true }
          )
          if (
            origin &&
            repository &&
            githubRepoIdentityKey({ ...repository, host: repository.host ?? origin.host }) !==
              githubRepoIdentityKey(origin)
          ) {
            throw new Error('Actions repository does not match the registered origin')
          }
          return origin
        },
        connectionId,
        localGitOptions
      ),
      controller.signal
    )
    if (!resolved.ownerRepo) {
      throw new Error('A verified GitHub repository is required for Actions')
    }
    const snapshot = snapshotCheckJobLogExecution(resolved.ownerRepo, resolved.ghOptions)
    const options = { ...snapshot.ghOptions, signal: controller.signal }
    const guard = repositoryRateLimitGuard(resolved.ownerRepo, 'core', options)
    if (guard.blocked) {
      throw new Error(
        `GitHub rate limit is low; retry after ${new Date(guard.resetAt * 1000).toISOString()}`
      )
    }
    await acquire(controller.signal).catch((error: unknown) => {
      controller.signal.throwIfAborted()
      throw error
    })
    admission = createCheckDetailsAdmissionLifetime(release)
    return await waitForCheckDetailsResolution(
      read(resolved.ownerRepo, options, {
        deadlineAt,
        executionScope: snapshot.executionScope,
        retainUntil: admission.retainUntil
      }),
      controller.signal
    )
  } catch (error) {
    controller.signal.throwIfAborted()
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    admission?.finish()
  }
}
/** Parse a GitHub API response using the caller’s account, execution route and abort signal. */
export async function actionsJson(endpoint: string, options: GhExecOptions): Promise<unknown> {
  const { stdout } = await ghExecFileAsync(['api', endpoint], options)
  return JSON.parse(stdout)
}
