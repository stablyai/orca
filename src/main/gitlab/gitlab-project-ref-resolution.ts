import { gitExecFileAsync } from '../git/runner'
import type { IssueSourcePreference } from '../../shared/types'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import { clearProjectRefInFlight, runProjectRefProbeOnce } from './project-ref-inflight'
import type { LocalGitExecOptions } from './gitlab-known-host-probe'
import { DEFAULT_GITLAB_HOSTS, parseGitLabProjectRef, type ProjectRef } from './project-ref-parser'

export { DEFAULT_GITLAB_HOSTS, parseGitLabProjectRef }
export type { ProjectRef }
export {
  getGlabKnownHosts,
  parseGlabAuthStatusHosts,
  setConfiguredGitLabUrl
} from './gitlab-known-host-probe'
export type { LocalGitExecOptions } from './gitlab-known-host-probe'

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
  const runtimeKey = connectionId ?? `local:${localGitOptions.wslDistro ?? 'host'}`
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
  cacheKey: string,
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
      rememberProjectRefCacheEntry(cacheKey, result)
      return result
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
  projectRef: Pick<ProjectRef, 'host'> | null | undefined,
  _connectionId?: string | null
): string[] {
  // Why: cwd inference is ambiguous when glab has multiple authenticated hosts;
  // route every resolved project explicitly, including local and WSL repos.
  return projectRef?.host ? ['--hostname', projectRef.host] : []
}
