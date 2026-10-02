import { ghExecFileAsync, acquire, release, type LocalGitExecOptions } from '../../gh-utils'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
import { mergeGitHubPRStack } from '../../github-pr-stack'
import { githubPRStackExecutionScope, type GhExecOptions } from './../github-exec-scope'
import { detectRepositoryMergeMetadata } from './../detect/repository-merge-metadata'
import type { PullRequestLookupData } from './../lookup/pull-request-lookup-data'
import { getRestPRByNumber, getPRByNumber } from './../lookup/pr-number-lookup'
import { STACK_METADATA_UNAVAILABLE_ERROR } from './../lookup/pr-stack-summary-cache'
/**
 * Merge a PR by number using gh CLI.
 * method: 'merge' | 'squash' | 'rebase' (default: 'squash')
 */
export async function mergePR(
  repoPath: string,
  prNumber: number,
  method: 'merge' | 'squash' | 'rebase' = 'squash',
  connectionId?: string | null,
  prRepo?: GitHubApiRepository | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { ownerRepo, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    prRepo,
    connectionId,
    localGitOptions
  )
  if (!ownerRepo) {
    return { ok: false, error: 'Could not resolve GitHub owner/repo for this repository' }
  }
  await acquire()
  let concurrencySlotHeld = true
  try {
    let restData: PullRequestLookupData
    try {
      restData = await getRestPRByNumber(ownerRepo, prNumber, ghOptions, {
        requireUsableStackMetadata: true
      })
    } catch (err) {
      const diagnostic =
        err instanceof SyntaxError
          ? 'invalid JSON response'
          : err instanceof Error
            ? err.message
            : String(err)
      console.warn(
        `mergePR stack metadata probe failed for ${ownerRepo.owner}/${ownerRepo.repo}#${String(prNumber)}:`,
        diagnostic
      )
      return { ok: false, error: STACK_METADATA_UNAVAILABLE_ERROR }
    }
    if (restData.stack) {
      const mergeMetadata = await detectRepositoryMergeMetadata(
        ownerRepo,
        restData.stack.baseRefName,
        ghOptions,
        githubPRStackExecutionScope(connectionId, localGitOptions)
      )
      release()
      concurrencySlotHeld = false
      return await mergeGitHubPRStack({
        repository: ownerRepo,
        prNumber,
        method,
        mergeAction: mergeMetadata.mergeQueueRequired === true ? 'merge_queue' : 'direct_merge',
        headSha: restData.headRefOid,
        ghOptions
      })
    }
    const mergeBlocker = await getPRMergeBlocker(
      prNumber,
      ownerRepo,
      ghOptions,
      connectionId,
      localGitOptions
    )
    if (mergeBlocker) {
      return { ok: false, error: mergeBlocker }
    }

    // Don't use --delete-branch: it deletes the local branch, which fails while the worktree is checked out on it.
    const args = ['pr', 'merge', String(prNumber), `--${method}`]
    if (ownerRepo) {
      args.push('--repo', `${ownerRepo.owner}/${ownerRepo.repo}`)
    }
    await ghExecFileAsync(args, {
      ...ghOptions,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' }
    })
    return { ok: true }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error'
    return { ok: false, error: message }
  } finally {
    if (concurrencySlotHeld) {
      release()
    }
  }
}

export async function getPRMergeBlocker(
  prNumber: number,
  ownerRepo: GitHubApiRepository | null,
  ghOptions: GhExecOptions,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<string | null> {
  if (!ownerRepo) {
    return null
  }

  try {
    const pr = await getPRByNumber(
      ownerRepo,
      prNumber,
      ghOptions,
      githubPRStackExecutionScope(connectionId, localGitOptions)
    )
    if (!pr) {
      return null
    }
    if (pr.reviewDecision === 'REVIEW_REQUIRED') {
      return 'This pull request requires review approval before it can be merged.'
    }
    if (pr.reviewDecision === 'CHANGES_REQUESTED') {
      return 'This pull request has requested changes and cannot be merged yet.'
    }
    if (pr.mergeQueueRequired === true) {
      return 'This pull request must be merged through GitHub merge queue. Use Merge when ready instead.'
    }
    if (pr.mergeable !== 'CONFLICTING') {
      return null
    }
    return formatMergeConflictBlocker(pr.baseRefName)
  } catch {
    // Why: conflict preflight should improve stale UI diagnostics, not block merge on a transient lookup failure.
    return null
  }
}

function formatMergeConflictBlocker(baseRefName: string | undefined): string {
  return `This pull request has merge conflicts and cannot be merged yet.\nUpdate the branch with ${baseRefName || 'the base branch'} and resolve the conflicts before merging.`
}
