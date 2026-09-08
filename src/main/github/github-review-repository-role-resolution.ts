import { githubRepoIdentityKey } from '../../shared/github/repository-identity-key'
import { configuredGitUpstreamIdentity, resolveHeadRole } from '../git/git-operation-remote-roles'
import { getGitRemoteTopologySnapshot } from '../git/git-remote-topology-snapshot'
import {
  bindRepositoryRole,
  resolveSnapshotRepositories,
  type GitRepositoryRole
} from '../git/git-repository-evidence'
import { resolveGitHubRepositoryUrl } from './github-enterprise-repository'
import { parseGitHubRemoteIdentity } from './github-remote-identity-parsing'
import type { GitHubApiRepository } from './github-api-repository'
import type { LocalGitExecOptions } from './gh-utils'

type ResolveRemote = (remoteName: string) => Promise<GitHubApiRepository | null>
export type GitHubApiRepositoryCandidates = {
  candidates: GitHubApiRepository[]
  headRepo: GitHubApiRepository | null
  head?: GitRepositoryRole<GitHubApiRepository>
  trackedHead?: { branchName: string; repository: GitHubApiRepository } | null
  unverifiableRemotes?: string[]
}

async function resolveConventionalCandidates(
  resolveRemote: ResolveRemote
): Promise<GitHubApiRepositoryCandidates> {
  const [upstream, origin] = await Promise.all([resolveRemote('upstream'), resolveRemote('origin')])
  const seen = new Set<string>()
  const candidates = [upstream, origin].filter((candidate): candidate is GitHubApiRepository => {
    if (!candidate) {
      return false
    }
    const key = githubRepoIdentityKey(candidate)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
  return { candidates, headRepo: origin }
}

export async function resolveGitHubReviewRepositoryRoles(args: {
  repoPath: string
  branchName?: string
  connectionId?: string | null
  localGitOptions: LocalGitExecOptions
  resolveRemote: ResolveRemote
}): Promise<GitHubApiRepositoryCandidates> {
  if (!args.branchName) {
    return resolveConventionalCandidates(args.resolveRemote)
  }
  const snapshot = await getGitRemoteTopologySnapshot(args)
  const repositories = await resolveSnapshotRepositories<GitHubApiRepository>(
    snapshot,
    async (url) => {
      const repository = await resolveGitHubRepositoryUrl(
        url,
        args.repoPath,
        args.connectionId,
        args.localGitOptions
      )
      if (repository) {
        return { kind: 'verified', repository }
      }
      // Authentication failure cannot exclude an otherwise plausible forge URL.
      return { kind: parseGitHubRemoteIdentity(url) ? 'unverifiable' : 'non-provider' }
    }
  )
  const plausible = snapshot.remoteNames.filter(
    (name) =>
      repositories.fetch.get(name)?.kind !== 'non-provider' ||
      repositories.push.get(name)?.some((evidence) => evidence.kind !== 'non-provider')
  )
  const headRole = resolveHeadRole(snapshot, args.branchName, plausible)
  const direction =
    headRole.kind === 'resolved' &&
    ['branch-push-remote', 'remote-push-default', 'sole-provider-remote'].includes(
      headRole.provenance
    )
      ? 'push'
      : 'fetch'
  const head = bindRepositoryRole(headRole, repositories, direction)
  const seen = new Set<string>()
  const candidates = [...repositories.fetch.values()].flatMap((evidence) => {
    if (evidence.kind !== 'verified') {
      return []
    }
    const key = githubRepoIdentityKey(evidence.repository)
    if (seen.has(key)) {
      return []
    }
    seen.add(key)
    return [evidence.repository]
  })
  const upstream = configuredGitUpstreamIdentity(snapshot, args.branchName)
  const tracked =
    upstream?.trackingRef && upstream.selector.kind === 'named-remote'
      ? { remoteName: upstream.selector.value, branchName: upstream.branchName }
      : null
  const trackedIdentity = tracked ? repositories.fetch.get(tracked.remoteName) : null
  return {
    candidates,
    headRepo: head.kind === 'resolved' ? head.repository : null,
    head,
    trackedHead:
      tracked && trackedIdentity?.kind === 'verified'
        ? { branchName: tracked.branchName, repository: trackedIdentity.repository }
        : null,
    unverifiableRemotes: [...repositories.fetch]
      .filter(([, e]) => e.kind === 'unverifiable')
      .map(([name]) => name)
  }
}
