import { getGitHubForkParent } from '../../repositories/github-fork-parent'
import {
  getRemoteUrlForRepo,
  githubRepoContext
} from '../../repositories/github-repository-identity'
import {
  parseGitHubRemoteIdentity,
  gitHubSshConfigHostAlias,
  effectiveGitHubRemoteHost
} from '../../repositories/github-remote-identity-parsing'
import type {
  GitHubRepositoryIdentity as OwnerRepo,
  GitHubRepositoryIdentity as GitHubApiRepository
} from '../../../../shared/github/repositories/repository-identity'
import {
  getHostedReviewLocalGitOptions,
  type HostedReviewExecutionOptions
} from '../../../source-control/hosted-review-git-options'
import {
  getGitHubApiRepositoryForRemote,
  getOriginGitHubApiRepository
} from '../../repositories/github-api-repository-remote-probe'

import { withSharedRemoteUrlReads } from '../../../git/remotes/remote-url-probe'
import { isStableMissingGitRemoteError } from '../../../git/remotes/stable-missing-git-remote-error'
import {
  normalizeForgeWebHost,
  foldWwwHostAlias
} from '../../../../shared/git/remotes/git-remote-host-alias'

import { resolveSshConfigHostname } from '../../repositories/github-ssh-host-alias-resolution'
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
      origin = await getOriginGitHubApiRepository(repoPath, connectionId, localGitOptions)
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
      return { upstream: await getGitHubForkParent(origin, context), origin }
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
