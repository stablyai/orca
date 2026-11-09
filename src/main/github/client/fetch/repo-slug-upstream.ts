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
  type GitHubApiRepository,
  type GitHubRepoExecOptions
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

/** Best-effort fork parent for indicators/avatar selection; failures return null. */
export async function getRepoUpstream(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<OwnerRepo | null> {
  try {
    return await resolveRepoUpstream(repoPath, connectionId, options)
  } catch {
    return null
  }
}

export async function resolveRepoUpstream(
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
    return await getRepositoryForkParent(origin, ghOptions)
  } finally {
    release()
  }
}

export async function getRepositoryForkParent(
  repository: GitHubApiRepository,
  ghOptions: GitHubRepoExecOptions
): Promise<OwnerRepo | null> {
  // Positional slugs bypass --repo qualification, so include the Enterprise host directly.
  const { stdout } = await ghExecFileAsync(
    ['repo', 'view', githubRepositorySlugArg(repository), '--json', 'isFork,parent'],
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
  if (data.isFork === false) {
    return null
  }
  if (data.isFork !== true || !owner || !repo) {
    throw new Error('GitHub fork parent could not be resolved.')
  }
  return { owner, repo, ...(repository.host ? { host: repository.host } : {}) }
}
