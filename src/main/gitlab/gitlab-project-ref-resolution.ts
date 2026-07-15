import { gitExecFileAsync, glabExecFileAsync } from '../git/runner'
import type { IssueSourcePreference } from '../../shared/types'
import { getSshGitProvider, getSshGitProviderRegistrationId } from '../providers/ssh-git-dispatch'
import { clearProjectRefInFlight, runProjectRefProbeOnce } from './project-ref-inflight'
import {
  areGlabKnownHostsCurrentForConnection,
  parseGlabAuthStatusHosts,
  rememberGlabKnownHost
} from './gitlab-known-host-cache'
import {
  DEFAULT_GITLAB_HOSTS,
  normalizeGitLabHost,
  parseGitLabProjectRef,
  parseRemoteProjectRefCandidate,
  type ProjectRef
} from './project-ref-parser'
import {
  assertProjectRefCurrentForConnection,
  rememberProjectRefLifecycle
} from './gitlab-project-ref-lifecycle'

export { DEFAULT_GITLAB_HOSTS, parseGitLabProjectRef }
export {
  _getKnownHostsCacheSize,
  _resetKnownHostsCache,
  getGlabKnownHosts,
  parseGlabAuthStatusHosts
} from './gitlab-known-host-cache'
export type { ProjectRef }

export type LocalGitExecOptions = {
  wslDistro?: string
}

const PROJECT_REF_CACHE_MAX_ENTRIES = 512
const projectRefCache = new Map<string, ProjectRef | null>()

/** @internal - exposed for tests only */
export function _resetProjectRefCache(): void {
  projectRefCache.clear()
  clearProjectRefInFlight()
}

/** @internal - exposed for tests only */
export function _getProjectRefCacheSize(): number {
  return projectRefCache.size
}

function rememberProjectRefCacheEntry(cacheKey: string, value: ProjectRef | null): void {
  projectRefCache.set(cacheKey, value)
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
  if (!areGlabKnownHostsCurrentForConnection(knownHosts, connectionId)) {
    return null
  }
  const sshProviderRegistrationId = connectionId
    ? getSshGitProviderRegistrationId(connectionId)
    : undefined
  const runtimeKey = connectionId
    ? `${connectionId}:${sshProviderRegistrationId ?? 'disconnected'}`
    : `local:${localGitOptions.wslDistro ?? 'host'}`
  const cacheKey = `${runtimeKey}\0${repoPath}\0${remoteName}\0${knownHosts.join(',')}`
  if (projectRefCache.has(cacheKey)) {
    return projectRefCache.get(cacheKey)!
  }

  return runProjectRefProbeOnce(cacheKey, () =>
    resolveProjectRefForRemote(
      repoPath,
      remoteName,
      knownHosts,
      connectionId,
      sshProviderRegistrationId,
      cacheKey,
      localGitOptions
    )
  )
}

async function resolveProjectRefForRemote(
  repoPath: string,
  remoteName: string,
  knownHosts: readonly string[],
  connectionId: string | null | undefined,
  sshProviderRegistrationId: number | undefined,
  cacheKey: string,
  localGitOptions: LocalGitExecOptions
): Promise<ProjectRef | null> {
  try {
    const sshGitProvider = connectionId ? getSshGitProvider(connectionId) : null
    if (
      connectionId &&
      (!sshGitProvider ||
        getSshGitProviderRegistrationId(connectionId) !== sshProviderRegistrationId)
    ) {
      return null
    }
    const { stdout } = sshGitProvider
      ? await sshGitProvider.exec(['remote', 'get-url', remoteName], repoPath)
      : await gitExecFileAsync(['remote', 'get-url', remoteName], {
          cwd: repoPath,
          ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
        })
    if (
      connectionId &&
      getSshGitProviderRegistrationId(connectionId) !== sshProviderRegistrationId
    ) {
      return null
    }
    const result = parseGitLabProjectRef(stdout, knownHosts)
    if (result) {
      rememberProjectRefLifecycle(result, connectionId, sshProviderRegistrationId)
      rememberProjectRefCacheEntry(cacheKey, result)
      return result
    }
    const remoteCandidate = parseRemoteProjectRefCandidate(stdout)
    if (
      remoteCandidate &&
      (!connectionId ||
        getSshGitProviderRegistrationId(connectionId) === sshProviderRegistrationId) &&
      (await isGlabConfiguredForRemoteHost(
        repoPath,
        remoteCandidate,
        connectionId,
        sshProviderRegistrationId,
        localGitOptions
      )) &&
      (!connectionId || getSshGitProviderRegistrationId(connectionId) === sshProviderRegistrationId)
    ) {
      rememberGlabKnownHost(remoteCandidate.host, connectionId)
      rememberProjectRefLifecycle(remoteCandidate, connectionId, sshProviderRegistrationId)
      rememberProjectRefCacheEntry(cacheKey, remoteCandidate)
      return remoteCandidate
    }
  } catch {
    if (connectionId) {
      return null
    }
  }
  rememberProjectRefCacheEntry(cacheKey, null)
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
  projectRef: ProjectRef | null | undefined,
  connectionId?: string | null
): string[] {
  if (projectRef) {
    assertProjectRefCurrentForConnection(projectRef, connectionId)
  }
  return connectionId && projectRef?.host ? ['--hostname', projectRef.host] : []
}

async function isGlabConfiguredForRemoteHost(
  repoPath: string,
  projectRef: Pick<ProjectRef, 'host'>,
  connectionId?: string | null,
  sshProviderRegistrationId?: number,
  localGitOptions: LocalGitExecOptions = {}
): Promise<boolean> {
  if (connectionId && getSshGitProviderRegistrationId(connectionId) !== sshProviderRegistrationId) {
    return false
  }
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
