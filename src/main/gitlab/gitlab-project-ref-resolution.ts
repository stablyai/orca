import { isTransientGitProbeError, readRemoteUrl } from '../git/remote-url-probe'
import { isStableMissingGitRemoteError } from '../git/stable-missing-git-remote-error'
import { getSshGitProviderGeneration } from '../providers/ssh-git-dispatch'
import type { IssueSourcePreference } from '../../shared/types'
import {
  clearProjectRefInFlight,
  runProjectRefProbeOnce,
  type ProjectRefProbeResult
} from './project-ref-inflight'
import {
  clearSoleRemoteNameProbeCache,
  resolveFromSoleRemote
} from './gitlab-sole-remote-name-probe'
import {
  _resetGlabUnauthenticatedHosts,
  GlabHostProbeUnavailableError,
  isGlabConfiguredForRemoteHost,
  rememberGlabKnownHost,
  type LocalGitExecOptions
} from './gitlab-known-host-probe'
import {
  clearProjectRefCache,
  getCachedProjectRef,
  getProjectRefCacheSize,
  rememberProjectRef
} from './gitlab-project-ref-cache'
import {
  DEFAULT_GITLAB_HOSTS,
  parseGitLabProjectRef,
  parseRemoteProjectRefCandidate,
  type ProjectRef
} from './project-ref-parser'

export { DEFAULT_GITLAB_HOSTS, parseGitLabProjectRef }
export type { ProjectRef }
export {
  _resetKnownHostsCache,
  getGlabKnownHosts,
  parseGlabAuthStatusHosts
} from './gitlab-known-host-probe'
export type { LocalGitExecOptions } from './gitlab-known-host-probe'
export { glabHostnameArgs, glabRepoExecOptions } from './gitlab-exec-options'

/** @internal - exposed for tests only */
export function _resetProjectRefCache(): void {
  clearProjectRefCache()
  clearProjectRefInFlight()
  clearSoleRemoteNameProbeCache()
  _resetGlabUnauthenticatedHosts()
}

/** @internal - exposed for tests only */
export function _getProjectRefCacheSize(): number {
  return getProjectRefCacheSize()
}

export async function getProjectRefForRemote(
  repoPath: string,
  remoteName: string,
  knownHosts: readonly string[] = DEFAULT_GITLAB_HOSTS,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ProjectRef | null> {
  return (
    await probeProjectRefForRemote(repoPath, remoteName, knownHosts, connectionId, localGitOptions)
  ).value
}

async function probeProjectRefForRemote(
  repoPath: string,
  remoteName: string,
  knownHosts: readonly string[] = DEFAULT_GITLAB_HOSTS,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ProjectRefProbeResult> {
  // Why: a reconnect replaces the host an answer came from under the same id, so
  // the generation is part of the signature; `knownHosts` carries the glab auth
  // state, so logging into a self-hosted instance re-asks rather than reusing a
  // ref resolved while that host was unknown.
  const runtimeKey = connectionId
    ? `${connectionId}:${getSshGitProviderGeneration(connectionId)}`
    : `local:${localGitOptions.wslDistro ?? 'host'}`
  const cacheKey = `${runtimeKey}\0${repoPath}\0${remoteName}\0${knownHosts.join(',')}`
  const cached = getCachedProjectRef(cacheKey)
  if (cached !== undefined) {
    return cached ? { status: 'found', value: cached } : { status: 'miss', value: null }
  }

  return runProjectRefProbeOnce(cacheKey, (ownsKey) =>
    resolveProjectRefForRemote(
      repoPath,
      remoteName,
      knownHosts,
      connectionId,
      cacheKey,
      ownsKey,
      localGitOptions
    )
  )
}

async function resolveProjectRefForRemote(
  repoPath: string,
  remoteName: string,
  knownHosts: readonly string[],
  connectionId: string | null | undefined,
  cacheKey: string,
  ownsKey: () => boolean,
  localGitOptions: LocalGitExecOptions
): Promise<ProjectRefProbeResult> {
  // Why: a probe abandoned as stale still runs, and the repo state it read is
  // older than whatever its successor already published. It may answer its own
  // callers; it may not overwrite the cache.
  const publish = (value: ProjectRef | null): void => {
    if (ownsKey()) {
      rememberProjectRef(cacheKey, value)
    }
  }
  try {
    const stdout = await readRemoteUrl(
      {
        repoPath,
        connectionId,
        ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
      },
      remoteName
    )
    if (stdout === null) {
      return { status: 'unavailable', value: null }
    }
    const result = parseGitLabProjectRef(stdout, knownHosts)
    if (result) {
      publish(result)
      return { status: 'found', value: result }
    }
    const remoteCandidate = parseRemoteProjectRefCandidate(stdout)
    if (
      remoteCandidate &&
      (await isGlabConfiguredForRemoteHost(remoteCandidate, connectionId, localGitOptions))
    ) {
      rememberGlabKnownHost(remoteCandidate.host, connectionId, localGitOptions)
      publish(remoteCandidate)
      return { status: 'found', value: remoteCandidate }
    }
  } catch (error) {
    // Why: a wedged or killed probe is not evidence the remote is not GitLab —
    // caching it would misdetect the forge until the negative expires (P1-D).
    // SSH failures stay uncached outright rather than adopting the generic
    // cache's stable-missing-remote exception: keeping a connected host's
    // detection fresh is worth the extra probe.
    if (isTransientGitProbeError(error) || error instanceof GlabHostProbeUnavailableError) {
      return { status: 'unavailable', value: null }
    }
    if (connectionId) {
      return isStableMissingGitRemoteError(error)
        ? { status: 'miss', value: null }
        : { status: 'unavailable', value: null }
    }
  }
  publish(null)
  return { status: 'miss', value: null }
}

export async function getProjectRef(
  repoPath: string,
  knownHosts?: readonly string[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ProjectRef | null> {
  const origin = await probeProjectRefForRemote(
    repoPath,
    'origin',
    knownHosts,
    connectionId,
    localGitOptions
  )
  if (origin.status !== 'miss') {
    return origin.value
  }
  return resolveFromSoleRemote(repoPath, ['origin'], connectionId, localGitOptions, (remoteName) =>
    getProjectRefForRemote(repoPath, remoteName, knownHosts, connectionId, localGitOptions)
  )
}

export async function getIssueProjectRef(
  repoPath: string,
  knownHosts?: readonly string[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ProjectRef | null> {
  const upstream = await probeProjectRefForRemote(
    repoPath,
    'upstream',
    knownHosts,
    connectionId,
    localGitOptions
  )
  if (upstream.status === 'found') {
    return upstream.value
  }
  const origin = await probeProjectRefForRemote(
    repoPath,
    'origin',
    knownHosts,
    connectionId,
    localGitOptions
  )
  if (origin.status === 'found') {
    return origin.value
  }
  if (upstream.status === 'unavailable' || origin.status === 'unavailable') {
    return null
  }
  return resolveFromSoleRemote(
    repoPath,
    ['upstream', 'origin'],
    connectionId,
    localGitOptions,
    (remoteName) =>
      getProjectRefForRemote(repoPath, remoteName, knownHosts, connectionId, localGitOptions)
  )
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
    const upstream = await probeProjectRefForRemote(
      repoPath,
      'upstream',
      knownHosts,
      connectionId,
      localGitOptions
    )
    if (upstream.status === 'found') {
      return { source: upstream.value, fellBack: false }
    }
    if (upstream.status === 'unavailable') {
      return { source: null, fellBack: false }
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
