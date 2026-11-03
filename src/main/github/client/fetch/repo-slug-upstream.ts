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
/** Resolve origin and upstream without replacing an unverifiable SSH probe with a local repository guess. */
export async function getRepoSlug(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions & { requireVerifiedSshProbe?: boolean } = {}
): Promise<GitHubApiRepository | null> {
  if (options.requireVerifiedSshProbe) {
    return getGitHubApiRepositoryForRemote(
      repoPath,
      'origin',
      connectionId,
      getHostedReviewLocalGitOptions(options),
      { requireVerifiedSshProbe: true }
    )
  }
  return getOriginGitHubApiRepository(
    repoPath,
    connectionId,
    getHostedReviewLocalGitOptions(options)
  )
}

/** Best-effort fork parent for indicators/avatar selection; failures return null. */
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
    // Positional slugs bypass --repo qualification, so include the Enterprise host directly.
    const { stdout } = await ghExecFileAsync(
      ['repo', 'view', githubRepositorySlugArg(origin), '--json', 'isFork,parent'],
      // Do not let optional metadata stall repository creation.
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
    return data.isFork && owner && repo
      ? { owner, repo, ...(origin.host ? { host: origin.host } : {}) }
      : null
  } catch {
    return null
  } finally {
    release()
  }
}
