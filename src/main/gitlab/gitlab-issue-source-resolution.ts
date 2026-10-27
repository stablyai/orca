import { listCachedRemoteNames, shouldProbeGitRemote } from '../git/remote-name-listing'
import type { IssueSourcePreference } from '../../shared/repo-types'
import {
  getProjectRefForRemote,
  type LocalGitExecOptions,
  type ProjectRef
} from './gitlab-project-ref-resolution'

export async function getIssueProjectRef(
  repoPath: string,
  knownHosts?: readonly string[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ProjectRef | null> {
  const originPromise = getProjectRefForRemote(
    repoPath,
    'origin',
    knownHosts,
    connectionId,
    localGitOptions
  )
  if (await shouldProbeGitRemote(repoPath, 'upstream', connectionId, localGitOptions)) {
    const upstream = await getProjectRefForRemote(
      repoPath,
      'upstream',
      knownHosts,
      connectionId,
      localGitOptions
    )
    if (upstream) {
      return upstream
    }
  }
  return (
    (await originPromise) ??
    getProjectRefForOtherRemote(repoPath, knownHosts, connectionId, localGitOptions)
  )
}

// Match glab project inference even when remotes use nonstandard names.
async function getProjectRefForOtherRemote(
  repoPath: string,
  knownHosts?: readonly string[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ProjectRef | null> {
  const remotes = await listCachedRemoteNames(repoPath, connectionId, localGitOptions)
  const otherRemotes = (remotes ?? []).filter((name) => name !== 'origin' && name !== 'upstream')
  // glab prioritizes a remote named gitlab.
  otherRemotes.sort((a, b) => Number(b === 'gitlab') - Number(a === 'gitlab'))
  for (const remoteName of otherRemotes) {
    const projectRef = await getProjectRefForRemote(
      repoPath,
      remoteName,
      knownHosts,
      connectionId,
      localGitOptions
    )
    if (projectRef) {
      return projectRef
    }
  }
  return null
}

export type ResolvedIssueSource = {
  source: ProjectRef | null
  /** True when explicit upstream is gone and resolver fell back to origin. */
  fellBack: boolean
}

export async function resolveIssueSource(
  repoPath: string,
  preference: IssueSourcePreference | undefined,
  knownHosts?: readonly string[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ResolvedIssueSource> {
  if (preference === 'upstream') {
    const upstream = await getProjectRefForRemote(
      repoPath,
      'upstream',
      knownHosts,
      connectionId,
      localGitOptions
    )
    if (upstream) {
      return { source: upstream, fellBack: false }
    }
    const origin = await getProjectRefForRemote(
      repoPath,
      'origin',
      knownHosts,
      connectionId,
      localGitOptions
    )
    return { source: origin, fellBack: origin !== null }
  }
  if (preference === 'origin') {
    return {
      source: await getProjectRefForRemote(
        repoPath,
        'origin',
        knownHosts,
        connectionId,
        localGitOptions
      ),
      fellBack: false
    }
  }
  return {
    source: await getIssueProjectRef(repoPath, knownHosts, connectionId, localGitOptions),
    fellBack: false
  }
}
