import { listCachedRemoteNames, shouldProbeGitRemote } from '../git/remote-name-listing'
import type { IssueSourcePreference } from '../../shared/repo-types'
import { readLocalGitConfigSignature } from '../github/local-git-config-signature'
import {
  getProjectRefForRemoteWithSignature,
  type LocalGitExecOptions,
  type ProjectRef
} from './gitlab-project-ref-resolution'

export async function getIssueProjectRef(
  repoPath: string,
  knownHosts?: readonly string[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ProjectRef | null> {
  return getIssueProjectRefWithSignature(
    readLocalGitConfigSignature({ repoPath, connectionId, ...localGitOptions }),
    repoPath,
    knownHosts,
    connectionId,
    localGitOptions
  )
}

async function getIssueProjectRefWithSignature(
  initialSignature: Promise<string | undefined>,
  repoPath: string,
  knownHosts?: readonly string[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ProjectRef | null> {
  const originPromise = getProjectRefForRemoteWithSignature(
    initialSignature,
    repoPath,
    'origin',
    knownHosts,
    connectionId,
    localGitOptions
  )
  if (await shouldProbeGitRemote(repoPath, 'upstream', connectionId, localGitOptions)) {
    const upstream = await getProjectRefForRemoteWithSignature(
      initialSignature,
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
    getProjectRefForOtherRemote(
      initialSignature,
      repoPath,
      knownHosts,
      connectionId,
      localGitOptions
    )
  )
}

// Match glab project inference even when remotes use nonstandard names.
async function getProjectRefForOtherRemote(
  initialSignature: Promise<string | undefined>,
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
    const projectRef = await getProjectRefForRemoteWithSignature(
      initialSignature,
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
  const initialSignature = readLocalGitConfigSignature({
    repoPath,
    connectionId,
    ...localGitOptions
  })
  if (preference === 'upstream') {
    const upstream = await getProjectRefForRemoteWithSignature(
      initialSignature,
      repoPath,
      'upstream',
      knownHosts,
      connectionId,
      localGitOptions
    )
    if (upstream) {
      return { source: upstream, fellBack: false }
    }
    const origin = await getProjectRefForRemoteWithSignature(
      initialSignature,
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
      source: await getProjectRefForRemoteWithSignature(
        initialSignature,
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
    source: await getIssueProjectRefWithSignature(
      initialSignature,
      repoPath,
      knownHosts,
      connectionId,
      localGitOptions
    ),
    fellBack: false
  }
}
