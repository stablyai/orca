import {
  ghExecFileAsync,
  acquire,
  release,
  classifyGhError,
  type LocalGitExecOptions
} from '../../gh-utils'
import { resolveGitHubRepoExecution, type GitHubApiRepository } from '../../github-api-repository'
import { getPRAutoMergeIdentity } from './pr-auto-merge'

/** Map a raw gh update-branch failure to an actionable message (e.g. already-up-to-date). */
export function classifyUpdatePRBranchError(message: string): string {
  if (/up[\s-]?to[\s-]?date/i.test(message)) {
    return 'This branch is already up to date with the base branch.'
  }
  return classifyGhError(message).message
}

/**
 * Merge the base branch into a PR's head branch (GitHub's "Update branch").
 * Guards on the fetched head OID so a stale UI cannot clobber a newer push.
 */
export async function updatePRBranch(
  repoPath: string,
  prNumber: number,
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
  try {
    const pr = await getPRAutoMergeIdentity(prNumber, ownerRepo, ghOptions)
    if (!pr?.id) {
      return { ok: false, error: 'Could not resolve GitHub pull request ID' }
    }
    // Why: without expectedHeadOid the update runs unguarded and could clobber a newer push, so refuse rather than proceed.
    if (!pr.headRefOid) {
      return {
        ok: false,
        error: 'Could not resolve the pull request head commit; refresh and try again.'
      }
    }
    const query = `mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID) {
    updatePullRequestBranch(input: {
      pullRequestId: $pullRequestId,
      expectedHeadOid: $expectedHeadOid
    }) {
      pullRequest { id }
    }
  }`
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${query}`,
      '-f',
      `pullRequestId=${pr.id}`,
      '-f',
      `expectedHeadOid=${pr.headRefOid}`
    ]
    await ghExecFileAsync(args, {
      ...ghOptions,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' }
    })
    return { ok: true }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unknown error'
    return { ok: false, error: classifyUpdatePRBranchError(message) }
  } finally {
    release()
  }
}
