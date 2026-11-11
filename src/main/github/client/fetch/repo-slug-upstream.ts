import {
  ghExecFileAsync,
  acquire,
  release,
  getRemoteUrlForRepo,
  githubRepoContext,
  parseGitHubRemoteIdentity,
  type OwnerRepo
} from '../../gh-utils'
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
import { withSharedRemoteUrlReads } from '../../../git/remotes/remote-url-probe'
import { isStableMissingGitRemoteError } from '../../../git/remotes/stable-missing-git-remote-error'
import {
  normalizeForgeWebHost,
  foldWwwHostAlias
} from '../../../../shared/git/remotes/git-remote-host-alias'
import {
  gitHubSshConfigHostAlias,
  effectiveGitHubRemoteHost
} from '../../github-remote-identity-parsing'
import { resolveSshConfigHostname } from '../../github-ssh-host-alias-resolution'
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

export type RepoUpstreamProbe = {
  // Undefined is unavailable evidence, never a durable non-fork verdict.
  upstream: OwnerRepo | null | undefined
  origin: GitHubApiRepository | null
}

export async function probeRepoUpstream(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {},
  resolveParent = true
): Promise<RepoUpstreamProbe> {
  return withSharedRemoteUrlReads(async () => {
    let origin: GitHubApiRepository | null = null
    try {
      const localGitOptions = hostedReviewLocalGitOptionArgs(options)[0] ?? {}
      const context = githubRepoContext(repoPath, connectionId, localGitOptions)
      let url: string | null
      try {
        url = await getRemoteUrlForRepo(context, 'origin')
      } catch (error) {
        if (isStableMissingGitRemoteError(error)) {
          return { upstream: null, origin }
        }
        throw error
      }
      // An unserved remote host is not evidence of a missing origin.
      if (url === null) {
        return { upstream: undefined, origin }
      }
      const parsed = parseGitHubRemoteIdentity(url)
      if (!parsed) {
        return { upstream: null, origin }
      }
      let host = parsed.host
      let hostResolved = true
      const alias = gitHubSshConfigHostAlias(url)
      if (alias) {
        const resolved = await resolveSshConfigHostname(alias, context)
        if (resolved.resolved && resolved.hostname) {
          host = effectiveGitHubRemoteHost(host, resolved.hostname)
        } else {
          hostResolved = false
        }
      }
      const forgeHost = normalizeForgeWebHost(foldWwwHostAlias(host))
      if (hostResolved && (forgeHost === 'gitlab.com' || forgeHost === 'bitbucket.org')) {
        return { upstream: null, origin }
      }
      const execution = await resolveGitHubRepoExecution(
        repoPath,
        undefined,
        connectionId,
        localGitOptions
      )
      origin = execution.ownerRepo
      // Missing auth for an arbitrary custom host does not prove it is another forge.
      if (!origin || !resolveParent) {
        return { upstream: undefined, origin }
      }
      const upstream = await getGitHubApiRepositoryForRemote(
        repoPath,
        'upstream',
        connectionId,
        localGitOptions
      )
      if (upstream && !sameOwnerRepo(upstream, origin)) {
        return { upstream, origin }
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      let acquired = false
      try {
        await acquire(controller.signal)
        acquired = true
        const { stdout } = await ghExecFileAsync(
          ['repo', 'view', githubRepositorySlugArg(origin), '--json', 'isFork,parent'],
          { ...execution.ghOptions, timeout: 10_000, signal: controller.signal }
        )
        const data = JSON.parse(stdout) as {
          isFork?: boolean
          parent?: { name?: string; owner?: { login?: string } } | null
        }
        if (data.isFork === false) {
          return { upstream: null, origin }
        }
        const owner = data.parent?.owner?.login
        const repo = data.parent?.name
        return {
          upstream:
            data.isFork === true &&
            typeof owner === 'string' &&
            owner.trim() &&
            typeof repo === 'string' &&
            repo.trim()
              ? { owner, repo, ...(origin.host ? { host: origin.host } : {}) }
              : undefined,
          origin
        }
      } finally {
        clearTimeout(timer)
        if (acquired) {
          release()
        }
      }
    } catch {
      return { upstream: undefined, origin }
    }
  })
}

/** Compatibility callers receive null when optional metadata is unavailable. */
export async function getRepoUpstream(
  repoPath: string,
  connectionId?: string | null,
  options: HostedReviewExecutionOptions = {}
): Promise<OwnerRepo | null> {
  return (await probeRepoUpstream(repoPath, connectionId, options)).upstream ?? null
}
