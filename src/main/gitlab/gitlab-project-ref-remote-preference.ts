import { listRemoteNames, type RemoteUrlProbeContext } from '../git/remote-url-probe'
import type { IssueSourcePreference } from '../../shared/types'
import type { LocalGitExecOptions } from './gitlab-known-host-probe'
import { getProjectRefForRemote, type ProjectRef } from './gitlab-project-ref-resolution'

/** Prefer upstream, then origin, then a stable name order for custom remotes. */
export function orderRemoteNamesForProjectRefProbe(remoteNames: readonly string[]): string[] {
  return [...remoteNames].sort((left, right) => {
    const rank = (name: string): number => {
      if (name === 'upstream') {
        return 0
      }
      if (name === 'origin') {
        return 1
      }
      return 2
    }
    const byRank = rank(left) - rank(right)
    return byRank !== 0 ? byRank : left.localeCompare(right)
  })
}

function remoteUrlProbeContext(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): RemoteUrlProbeContext {
  return {
    repoPath,
    connectionId,
    ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
  }
}

/**
 * Probe preferred remote names first, then any remaining configured remotes.
 * Why: repos often use a custom remote label (not origin/upstream); Issues and
 * hosted-review still need a GitLab project ref when that label's host matches.
 */
export async function getProjectRefPreferringRemotes(
  repoPath: string,
  preferredRemoteNames: readonly string[],
  knownHosts?: readonly string[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ProjectRef | null> {
  const tried = new Set<string>()
  for (const remoteName of preferredRemoteNames) {
    tried.add(remoteName)
    const ref = await getProjectRefForRemote(
      repoPath,
      remoteName,
      knownHosts,
      connectionId,
      localGitOptions
    )
    if (ref) {
      return ref
    }
  }

  const configured = await listRemoteNames(
    remoteUrlProbeContext(repoPath, connectionId, localGitOptions)
  )
  for (const remoteName of orderRemoteNamesForProjectRefProbe(configured)) {
    if (tried.has(remoteName)) {
      continue
    }
    tried.add(remoteName)
    const ref = await getProjectRefForRemote(
      repoPath,
      remoteName,
      knownHosts,
      connectionId,
      localGitOptions
    )
    if (ref) {
      return ref
    }
  }
  return null
}

export async function getProjectRef(
  repoPath: string,
  knownHosts?: readonly string[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ProjectRef | null> {
  return getProjectRefPreferringRemotes(
    repoPath,
    ['origin'],
    knownHosts,
    connectionId,
    localGitOptions
  )
}

export async function getIssueProjectRef(
  repoPath: string,
  knownHosts?: readonly string[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ProjectRef | null> {
  return getProjectRefPreferringRemotes(
    repoPath,
    ['upstream', 'origin'],
    knownHosts,
    connectionId,
    localGitOptions
  )
}

export type ResolvedIssueSource = {
  source: ProjectRef | null
  /** True when explicit upstream is gone and resolver fell back to another remote. */
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
    // Origin (then any other configured remote) when upstream is absent.
    const fallback = await getProjectRefPreferringRemotes(
      repoPath,
      ['origin'],
      knownHosts,
      connectionId,
      localGitOptions
    )
    return { source: fallback, fellBack: fallback !== null }
  }
  if (preference === 'origin') {
    // Explicit origin preference keeps that remote name only — no custom fallback.
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
