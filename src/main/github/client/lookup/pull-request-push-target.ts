import type { IssueSourcePreference } from '../../../../shared/repo-types'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import {
  ghExecFileAsync,
  acquire,
  release,
  ghRepoExecOptions,
  githubRepoContext,
  getRemoteUrlForRepo,
  type LocalGitExecOptions
} from '../../gh-utils'
import {
  getGitHubApiRepositoryForRemote,
  githubHostExecOptions,
  type GitHubApiRepository
} from '../../github-api-repository'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import { isNotFoundGhError } from './../gh-error-predicates'
import { resolvePullRequestLookupCandidates } from './../pull-request-lookup-candidates'
export function pickPushRemoteUrl(args: {
  originUrl: string | null
  cloneUrl: string
  sshUrl: string
}): string {
  const { originUrl, cloneUrl, sshUrl } = args
  // Why: GHES port-443 SSH uses `ssh.<enterprise-host>`, not just ssh.github.com.
  if (originUrl && (/^(git@|ssh:)/.test(originUrl) || /:\/\/(?:[^@/]+@)?ssh\./.test(originUrl))) {
    return sshUrl
  }
  return cloneUrl
}

export function sanitizeRemoteName(owner: string, repo: string): string {
  const slug = `${owner}-${repo}`
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
  return slug ? `pr-${slug}` : 'pr-head'
}

/**
 * A fork push target plus the PR's `maintainer_can_modify` flag, kept outside
 * {@link GitPushTarget} so it never leaks into the persisted push-target shape.
 */
export type PullRequestPushTarget = {
  pushTarget: GitPushTarget
  /** false when the PR has "Allow edits from maintainers" off; a push may be rejected. */
  maintainerCanModify?: boolean
}

export async function getPullRequestPushTarget(
  repoPath: string,
  prNumber: number,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  preference?: IssueSourcePreference
): Promise<PullRequestPushTarget | null> {
  const context = githubRepoContext(repoPath, connectionId, localGitOptions)
  const ghOptions = ghRepoExecOptions(context)
  const candidates = await resolvePullRequestLookupCandidates(
    repoPath,
    preference,
    connectionId,
    localGitOptions
  )
  if (candidates.length === 0) {
    return null
  }

  await acquire()
  try {
    let prStdout = ''
    let matchedRepository: GitHubApiRepository | null = null
    for (const candidate of candidates) {
      try {
        const { stdout } = await ghExecFileAsync(
          ['api', `repos/${candidate.owner}/${candidate.repo}/pulls/${prNumber}`],
          { ...ghOptions, ...githubHostExecOptions(candidate) }
        )
        prStdout = stdout
        matchedRepository = candidate
        break
      } catch (error) {
        // Why: origin is often the contributor fork while the PR belongs to upstream; probe all PR repos before giving up.
        if (isNotFoundGhError(error)) {
          continue
        }
        throw error
      }
    }
    if (!prStdout || !matchedRepository) {
      return null
    }
    const origin = await getGitHubApiRepositoryForRemote(
      repoPath,
      'origin',
      connectionId,
      localGitOptions
    )
    const pr = JSON.parse(prStdout) as {
      maintainer_can_modify?: boolean
      head?: {
        ref?: string
        repo?: {
          full_name?: string
          clone_url?: string
          ssh_url?: string
          owner?: { login?: string }
          name?: string
        } | null
      }
    }
    const headRepo = pr.head?.repo
    const branchName = pr.head?.ref?.trim()
    const owner = headRepo?.owner?.login?.trim()
    const repo = headRepo?.name?.trim() ?? headRepo?.full_name?.split('/')[1]?.trim()
    const cloneUrl = headRepo?.clone_url?.trim()
    const sshUrl = headRepo?.ssh_url?.trim()
    const maintainerCanModify =
      typeof pr.maintainer_can_modify === 'boolean' ? pr.maintainer_can_modify : undefined
    if (!owner || !repo || !branchName || !cloneUrl || !sshUrl) {
      return null
    }
    if (
      origin &&
      githubRepoIdentityKey(origin) ===
        githubRepoIdentityKey({ owner, repo, host: matchedRepository.host })
    ) {
      return {
        pushTarget: { remoteName: 'origin', branchName },
        ...(maintainerCanModify !== undefined ? { maintainerCanModify } : {})
      }
    }

    let originUrl: string | null = null
    try {
      const rawOriginUrl = await getRemoteUrlForRepo(context, 'origin')
      originUrl = rawOriginUrl?.trim() || null
    } catch {
      originUrl = null
    }
    return {
      pushTarget: {
        remoteName: sanitizeRemoteName(owner, repo),
        branchName,
        remoteUrl: pickPushRemoteUrl({ originUrl, cloneUrl, sshUrl })
      },
      ...(maintainerCanModify !== undefined ? { maintainerCanModify } : {})
    }
  } finally {
    release()
  }
}
