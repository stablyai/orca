import { gitExecFileAsync, glabExecFileAsync } from '../git/runner'
import type { IssueSourcePreference } from '../../shared/types'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import { clearProjectRefInFlight, runProjectRefProbeOnce } from './project-ref-inflight'
import {
  buildRepositoryRefCacheKey,
  RepositoryRefCache
} from '../source-control/repository-ref-cache'
import {
  parseGlabAuthStatusHosts,
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
  GLAB_KNOWN_HOST_MAX_BYTES,
  GLAB_KNOWN_HOSTS_CONTEXT_KEYS_MAX_BYTES,
  GLAB_KNOWN_HOSTS_CONTEXT_KEY_MAX_BYTES,
  GLAB_KNOWN_HOSTS_CONTEXT_MAX_ENTRIES,
  GLAB_KNOWN_HOSTS_MAX_BYTES,
  GLAB_KNOWN_HOSTS_MAX_ENTRIES,
  GLAB_KNOWN_HOSTS_MAX_IN_FLIGHT,
  GLAB_KNOWN_HOSTS_OUTPUT_MAX_BYTES,
  _getKnownHostsCacheState,
  _resetKnownHostsCache,
  getGlabKnownHosts,
  parseGlabAuthStatusHosts,
  rememberGlabKnownHost
} from './gitlab-known-host-probe'
export type { LocalGitExecOptions } from './gitlab-known-host-probe'

const projectRefCache = new RepositoryRefCache<ProjectRef>()

/** @internal - exposed for tests only */
export function _resetProjectRefCache(): void {
  projectRefCache.clear()
  clearProjectRefInFlight()
}

/** @internal - exposed for tests only */
export function _getProjectRefCacheSize(): number {
  return projectRefCache.size
}

export async function getProjectRefForRemote(
  repoPath: string,
  remoteName: string,
  knownHosts: readonly string[] = DEFAULT_GITLAB_HOSTS,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ProjectRef | null> {
  const runtimeKey = connectionId ?? `local:${localGitOptions.wslDistro ?? 'host'}`
  const cacheKey = buildRepositoryRefCacheKey([runtimeKey, repoPath, remoteName, ...knownHosts])
  const cached = projectRefCache.get(cacheKey)
  if (cached.found) {
    return cached.value
  }

  const probe = () =>
    resolveProjectRefForRemote(
      repoPath,
      remoteName,
      knownHosts,
      connectionId,
      cacheKey,
      localGitOptions
    )
  return cacheKey === null ? probe() : runProjectRefProbeOnce(cacheKey, probe)
}

async function resolveProjectRefForRemote(
  repoPath: string,
  remoteName: string,
  knownHosts: readonly string[],
  connectionId: string | null | undefined,
  cacheKey: string | null,
  localGitOptions: LocalGitExecOptions
): Promise<ProjectRef | null> {
  try {
    const sshGitProvider = connectionId ? getSshGitProvider(connectionId) : null
    if (connectionId && !sshGitProvider) {
      return null
    }
    const { stdout } = sshGitProvider
      ? await sshGitProvider.exec(['remote', 'get-url', remoteName], repoPath)
      : await gitExecFileAsync(['remote', 'get-url', remoteName], {
          cwd: repoPath,
          ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
        })
    const result = parseGitLabProjectRef(stdout, knownHosts)
    if (result) {
      projectRefCache.remember(cacheKey, result, [result.host, result.path])
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
      projectRefCache.remember(cacheKey, remoteCandidate, [
        remoteCandidate.host,
        remoteCandidate.path
      ])
      return remoteCandidate
    }
  } catch {
    if (connectionId) {
      return null
    }
  }
  projectRefCache.remember(cacheKey, null, [])
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
  try {
    const result = await glabExecFileAsync(
      ['auth', 'status', '--hostname', projectRef.host],
      glabRepoExecOptions(repoPath, connectionId, localGitOptions)
    )
    return result !== undefined
  } catch (error) {
    const execLike = error as { stdout?: unknown; stderr?: unknown; message?: unknown }
    const output =
      [execLike.stdout, execLike.stderr, execLike.message]
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .join('\n') || String(error)
    const hosts = parseGlabAuthStatusHosts(output).map(normalizeGitLabHost)
    return hosts.includes(normalizeGitLabHost(projectRef.host))
  }
}
