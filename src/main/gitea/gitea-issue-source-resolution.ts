import { listCachedRemoteNames, shouldProbeGitRemote } from '../git/remote-name-listing'
import type { IssueSourcePreference } from '../../shared/repo-types'
import {
  getGiteaRepoRefForRemote,
  type GiteaRepoRef,
  type LocalGitExecOptions
} from './repository-ref'

export type ResolvedGiteaIssueSource = {
  source: GiteaRepoRef | null
  /** True when explicit upstream is gone and resolver fell back to origin. */
  fellBack: boolean
}

export async function getGiteaIssueRepoRef(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaRepoRef | null> {
  const originPromise = getGiteaRepoRefForRemote(repoPath, 'origin', connectionId, localGitOptions)
  if (await shouldProbeGitRemote(repoPath, 'upstream', connectionId, localGitOptions)) {
    const upstream = await getGiteaRepoRefForRemote(
      repoPath,
      'upstream',
      connectionId,
      localGitOptions
    )
    if (upstream) {
      return upstream
    }
  }
  return (
    (await originPromise) ?? getGiteaRepoRefForOtherRemote(repoPath, connectionId, localGitOptions)
  )
}

async function getGiteaRepoRefForOtherRemote(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GiteaRepoRef | null> {
  const remotes = await listCachedRemoteNames(repoPath, connectionId, localGitOptions)
  const otherRemotes = (remotes ?? []).filter((name) => name !== 'origin' && name !== 'upstream')
  otherRemotes.sort((left, right) => Number(right === 'gitea') - Number(left === 'gitea'))
  for (const remoteName of otherRemotes) {
    const repoRef = await getGiteaRepoRefForRemote(
      repoPath,
      remoteName,
      connectionId,
      localGitOptions
    )
    if (repoRef) {
      return repoRef
    }
  }
  return null
}

export async function resolveGiteaIssueSource(
  repoPath: string,
  preference?: IssueSourcePreference,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ResolvedGiteaIssueSource> {
  if (preference === 'upstream') {
    const upstream = await getGiteaRepoRefForRemote(
      repoPath,
      'upstream',
      connectionId,
      localGitOptions
    )
    if (upstream) {
      return { source: upstream, fellBack: false }
    }
    const origin = await getGiteaRepoRefForRemote(repoPath, 'origin', connectionId, localGitOptions)
    return { source: origin, fellBack: origin !== null }
  }
  if (preference === 'origin') {
    return {
      source: await getGiteaRepoRefForRemote(repoPath, 'origin', connectionId, localGitOptions),
      fellBack: false
    }
  }
  return {
    source: await getGiteaIssueRepoRef(repoPath, connectionId, localGitOptions),
    fellBack: false
  }
}
