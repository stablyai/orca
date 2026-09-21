import { ghExecFileAsync, acquire, release, type OwnerRepo } from '../../gh-utils'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../../../source-control/hosted-review-git-options'
import {
  getGitHubApiRepositoryForRemote,
  getOriginGitHubApiRepository,
  githubRepositorySlugArg,
  resolveGitHubRepoExecution,
  type GitHubApiRepository
} from '../../github-api-repository'
import { hostedReviewLocalGitOptionArgs, sameOwnerRepo } from './../github-exec-scope'
export async function getRepoSlug(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<GitHubApiRepository | null> {
  return getOriginGitHubApiRepository(
    repoPath,
    connectionId,
    getHostedReviewLocalGitOptions(options)
  )
}

/**
 * Resolve a fork's upstream/parent owner/repo, or null when not a fork.
 * Why: drives the fork indicator, and a same-name fork's avatar prefers the
 * upstream owner (a renamed fork keeps its own owner).
 * Best-effort: any failure (offline, unauthed, non-GitHub) resolves to null.
 */
export async function getRepoUpstream(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<OwnerRepo | null> {
  const localGitArgs = hostedReviewLocalGitOptionArgs(options)
  const localGitOptions = localGitArgs[0] ?? {}
  const { ownerRepo: origin, ghOptions } = await resolveGitHubRepoExecution(
    repoPath,
    undefined,
    connectionId,
    localGitOptions
  )
  if (!origin) {
    return null
  }
  const upstreamRemote = await getGitHubApiRepositoryForRemote(
    repoPath,
    'upstream',
    connectionId,
    localGitOptions
  )
  if (upstreamRemote && !sameOwnerRepo(upstreamRemote, origin)) {
    return upstreamRemote
  }
  await acquire()
  try {
    // Why: positional slugs bypass the runner's --repo qualifier, so the slug
    // itself must carry the Enterprise host.
    const { stdout } = await ghExecFileAsync(
      ['repo', 'view', githubRepositorySlugArg(origin), '--json', 'isFork,parent'],
      // Why: cap this best-effort add-time lookup so a stalled gh process can't hold up repo creation.
      {
        ...ghOptions,
        timeout: 10_000
      }
    )
    const data = JSON.parse(stdout) as {
      isFork?: boolean
      parent?: { name?: string; owner?: { login?: string } } | null
    }
    const owner = data.parent?.owner?.login
    const repo = data.parent?.name
    // Why: a fork parent lives on the same server as the fork.
    return data.isFork && owner && repo
      ? { owner, repo, ...(origin.host ? { host: origin.host } : {}) }
      : null
  } catch {
    return null
  } finally {
    release()
  }
}
