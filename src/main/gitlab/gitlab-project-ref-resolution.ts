import { glabExecFileAsync } from '../git/runner'
import { isTransientGitProbeError, readRemoteUrl } from '../git/remote-url-probe'
import { NEGATIVE_ENTRY_TTL_MS } from '../git/remote-ref-probe-cache'
import { getSshGitProviderGeneration } from '../providers/ssh-git-dispatch'
import type { IssueSourcePreference } from '../../shared/types'
import { clearProjectRefInFlight, runProjectRefProbeOnce } from './project-ref-inflight'
import {
  _resetGlabUnauthenticatedHosts,
  isGlabHostKnownUnauthenticated,
  parseGlabAuthStatusHosts,
  rememberGlabHostUnauthenticated,
  rememberGlabKnownHost,
  type LocalGitExecOptions
} from './gitlab-known-host-probe'
import {
  DEFAULT_GITLAB_HOSTS,
  normalizeGitLabHost,
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

const PROJECT_REF_CACHE_MAX_ENTRIES = 512

type CachedProjectRef = { value: ProjectRef | null; expiresAt: number }

const projectRefCache = new Map<string, CachedProjectRef>()

/** @internal - exposed for tests only */
export function _resetProjectRefCache(): void {
  projectRefCache.clear()
  clearProjectRefInFlight()
  _resetGlabUnauthenticatedHosts()
}

/** @internal - exposed for tests only */
export function _getProjectRefCacheSize(): number {
  return projectRefCache.size
}

function rememberProjectRefCacheEntry(cacheKey: string, value: ProjectRef | null): void {
  // Why: "not GitLab" only holds until someone configures `origin` or logs into
  // `glab` — a repo probed before either kept hosted-review detection stale for
  // the life of the process. Negatives expire the way every other forge's do;
  // positives still stay (see `createRemoteRefProbeCache`).
  projectRefCache.set(cacheKey, {
    value,
    expiresAt: value === null ? Date.now() + NEGATIVE_ENTRY_TTL_MS : Number.POSITIVE_INFINITY
  })
  while (projectRefCache.size > PROJECT_REF_CACHE_MAX_ENTRIES) {
    const oldestKey = projectRefCache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    projectRefCache.delete(oldestKey)
  }
}

export async function getProjectRefForRemote(
  repoPath: string,
  remoteName: string,
  knownHosts: readonly string[] = DEFAULT_GITLAB_HOSTS,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ProjectRef | null> {
  // Why: a reconnect replaces the host an answer came from under the same id, so
  // the generation is part of the signature; `knownHosts` carries the glab auth
  // state, so logging into a self-hosted instance re-asks rather than reusing a
  // ref resolved while that host was unknown.
  const runtimeKey = connectionId
    ? `${connectionId}:${getSshGitProviderGeneration(connectionId)}`
    : `local:${localGitOptions.wslDistro ?? 'host'}`
  const cacheKey = `${runtimeKey}\0${repoPath}\0${remoteName}\0${knownHosts.join(',')}`
  const cached = projectRefCache.get(cacheKey)
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return cached.value
    }
    projectRefCache.delete(cacheKey)
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
): Promise<ProjectRef | null> {
  // Why: a probe abandoned as stale still runs, and the repo state it read is
  // older than whatever its successor already published. It may answer its own
  // callers; it may not overwrite the cache.
  const publish = (value: ProjectRef | null): void => {
    if (ownsKey()) {
      rememberProjectRefCacheEntry(cacheKey, value)
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
      return null
    }
    const result = parseGitLabProjectRef(stdout, knownHosts)
    if (result) {
      publish(result)
      return result
    }
    const remoteCandidate = parseRemoteProjectRefCandidate(stdout)
    if (
      remoteCandidate &&
      (await isGlabConfiguredForRemoteHost(
        repoPath,
        remoteCandidate,
        connectionId,
        localGitOptions
      ))
    ) {
      rememberGlabKnownHost(remoteCandidate.host, connectionId, localGitOptions)
      publish(remoteCandidate)
      return remoteCandidate
    }
  } catch (error) {
    // Why: a wedged or killed probe is not evidence the remote is not GitLab —
    // caching it would misdetect the forge until the negative expires (P1-D).
    // SSH failures stay uncached outright rather than adopting the generic
    // cache's stable-missing-remote exception: keeping a connected host's
    // detection fresh is worth the extra probe.
    if (connectionId || isTransientGitProbeError(error)) {
      return null
    }
  }
  publish(null)
  return null
}

export async function getProjectRef(
  repoPath: string,
  knownHosts?: readonly string[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ProjectRef | null> {
  return getProjectRefForRemote(repoPath, 'origin', knownHosts, connectionId, localGitOptions)
}

export async function getIssueProjectRef(
  repoPath: string,
  knownHosts?: readonly string[],
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ProjectRef | null> {
  const upstream = await getProjectRefForRemote(
    repoPath,
    'upstream',
    knownHosts,
    connectionId,
    localGitOptions
  )
  return (
    upstream ??
    getProjectRefForRemote(repoPath, 'origin', knownHosts, connectionId, localGitOptions)
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

export function glabRepoExecOptions(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): { cwd?: string; wslDistro?: string } {
  return connectionId
    ? {}
    : {
        cwd: repoPath,
        ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
      }
}

export function glabHostnameArgs(
  projectRef: Pick<ProjectRef, 'host'> | null | undefined,
  connectionId?: string | null
): string[] {
  return connectionId && projectRef?.host ? ['--hostname', projectRef.host] : []
}

async function isGlabConfiguredForRemoteHost(
  repoPath: string,
  projectRef: Pick<ProjectRef, 'host'>,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<boolean> {
  // Why: this probe is per host, but the project-ref miss that reaches it is per
  // repo — without the memo, every non-GitLab repo re-spawns `glab` each time
  // its negative expires.
  if (isGlabHostKnownUnauthenticated(projectRef.host, connectionId, localGitOptions)) {
    return false
  }
  try {
    const result = await glabExecFileAsync(
      ['auth', 'status', '--hostname', projectRef.host],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
    if (result === undefined) {
      rememberGlabHostUnauthenticated(projectRef.host, connectionId, localGitOptions)
      return false
    }
    return true
  } catch (error) {
    const execLike = error as { stdout?: unknown; stderr?: unknown; message?: unknown }
    const output =
      [execLike.stdout, execLike.stderr, execLike.message]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join('\n') || String(error)
    const hosts = parseGlabAuthStatusHosts(output).map(normalizeGitLabHost)
    if (hosts.includes(normalizeGitLabHost(projectRef.host))) {
      return true
    }
    rememberGlabHostUnauthenticated(projectRef.host, connectionId, localGitOptions)
    return false
  }
}
