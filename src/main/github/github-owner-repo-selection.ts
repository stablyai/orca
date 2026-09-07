import type { IssueSourcePreference } from '../../shared/repo-types'
import { githubRepoIdentityKey } from '../../shared/github/repository-identity-key'
import {
  getOwnerRepoForRemote,
  type LocalGitExecOptions,
  type OwnerRepo
} from './github-repository-identity'

export async function getOwnerRepo(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<OwnerRepo | null> {
  // Why: on a fork checkout PRs live on the upstream parent, not origin (#7331).
  const upstream = await getOwnerRepoForRemote(repoPath, 'upstream', connectionId, localGitOptions)
  if (upstream) {
    return upstream
  }
  return getOwnerRepoForRemote(repoPath, 'origin', connectionId, localGitOptions)
}

export const getIssueOwnerRepo = getOwnerRepo

export type PRRepositoryCandidates = {
  candidates: OwnerRepo[]
  headRepo: OwnerRepo | null
}

export async function resolvePRRepositoryCandidates(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<PRRepositoryCandidates> {
  const [upstream, origin] = await Promise.all([
    getOwnerRepoForRemote(repoPath, 'upstream', connectionId, localGitOptions),
    getOwnerRepoForRemote(repoPath, 'origin', connectionId, localGitOptions)
  ])
  const seen = new Set<string>()
  const candidates: OwnerRepo[] = []

  for (const candidate of [upstream, origin]) {
    if (!candidate) {
      continue
    }
    const key = githubRepoIdentityKey(candidate)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    candidates.push(candidate)
  }

  return { candidates, headRepo: origin }
}

export type ResolvedIssueSource = {
  source: OwnerRepo | null
  /** True when explicit upstream is gone and resolver fell back to origin. */
  fellBack: boolean
}

export async function resolveIssueSource(
  repoPath: string,
  preference: IssueSourcePreference | undefined,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ResolvedIssueSource> {
  if (preference === 'upstream') {
    const upstream = await getOwnerRepoForRemote(
      repoPath,
      'upstream',
      connectionId,
      localGitOptions
    )
    if (upstream) {
      return { source: upstream, fellBack: false }
    }
    const origin = await getOwnerRepoForRemote(repoPath, 'origin', connectionId, localGitOptions)
    return { source: origin, fellBack: origin !== null }
  }
  if (preference === 'origin') {
    return {
      source: await getOwnerRepoForRemote(repoPath, 'origin', connectionId, localGitOptions),
      fellBack: false
    }
  }
  return {
    source: await getIssueOwnerRepo(repoPath, connectionId, localGitOptions),
    fellBack: false
  }
}
