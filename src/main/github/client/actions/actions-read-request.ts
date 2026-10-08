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
  read: (repository: GitHubApiRepository, options: GhExecOptions) => Promise<T>,
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
  let acquired = false
  try {
    const resolved = await waitForCheckDetailsResolution(
      resolveGitHubRepoExecution(
        repoPath,
        repository ??
          (() =>
            getGitHubApiRepositoryForRemote(repoPath, 'origin', connectionId, localGitOptions, {
              requireVerifiedSshProbe: true
            })),
        connectionId,
        localGitOptions
      ),
      controller.signal
    )
    if (!resolved.ownerRepo) {
      throw new Error('A verified GitHub repository is required for Actions')
    }
    const options = { ...resolved.ghOptions, signal: controller.signal }
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
    acquired = true
    return await waitForCheckDetailsResolution(read(resolved.ownerRepo, options), controller.signal)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    if (acquired) {
      release()
    }
  }
}
/** Parse a GitHub API response using the caller’s account, execution route and abort signal. */
export async function actionsJson(endpoint: string, options: GhExecOptions): Promise<unknown> {
  const { stdout } = await ghExecFileAsync(['api', endpoint], options)
  return JSON.parse(stdout)
}
