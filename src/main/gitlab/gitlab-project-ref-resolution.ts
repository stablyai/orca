import { glabExecFileAsync } from '../git/runner'
import type { GitAdmissionTier } from '../git/command-runner/git-exec-options'
import { addWslEnvKeys } from '../wsl-env'
import { isTransientGitProbeError, readRemoteUrl } from '../git/remote-url-probe'
import { NEGATIVE_ENTRY_TTL_MS } from '../git/remote-ref-probe-cache'
import { readLocalGitConfigSignature } from '../github/local-git-config-signature'
import { clearProjectRefInFlight, runProjectRefProbeOnce } from './project-ref-inflight'
import {
  _resetGlabUnauthenticatedHosts,
  getGlabPartialHosts,
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

type CachedProjectRef = { value: ProjectRef | null; expiresAt: number; configSignature?: string }

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

function rememberProjectRefCacheEntry(
  cacheKey: string,
  value: ProjectRef | null,
  configSignature?: string
): void {
  // Git config signatures omit global Git, SSH and auth configuration, so signed hits also expire.
  projectRefCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + NEGATIVE_ENTRY_TTL_MS,
    ...(configSignature !== undefined ? { configSignature } : {})
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
  return getProjectRefForRemoteWithSignature(
    readLocalGitConfigSignature({ repoPath, connectionId, ...localGitOptions }),
    repoPath,
    remoteName,
    knownHosts,
    connectionId,
    localGitOptions
  )
}

export async function getProjectRefForRemoteWithSignature(
  initialSignature: Promise<string | undefined>,
  repoPath: string,
  remoteName: string,
  knownHosts: readonly string[] = DEFAULT_GITLAB_HOSTS,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ProjectRef | null> {
  // Authenticated host inventory participates in cache identity so new logins invalidate old misses.
  const runtimeKey = connectionId ?? `local:${localGitOptions.wslDistro ?? 'host'}`
  const cacheKey = `${runtimeKey}\0${repoPath}\0${remoteName}\0${knownHosts.join(',')}`
  const configSignature = await initialSignature
  const cached = projectRefCache.get(cacheKey)
  if (cached) {
    if (
      cached.expiresAt > Date.now() &&
      configSignature !== undefined &&
      cached.configSignature === configSignature
    ) {
      return cached.value
    }
    projectRefCache.delete(cacheKey)
  }

  return runProjectRefProbeOnce(`${cacheKey}\0${configSignature ?? ''}`, (ownsKey) =>
    resolveProjectRefForRemote(
      repoPath,
      remoteName,
      knownHosts,
      connectionId,
      cacheKey,
      ownsKey,
      localGitOptions,
      configSignature
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
  localGitOptions: LocalGitExecOptions,
  configSignature: string | undefined
): Promise<ProjectRef | null> {
  // Abandoned probes may answer their callers but must not overwrite newer cached identity.
  const publish = (value: ProjectRef | null): void => {
    if (ownsKey()) {
      rememberProjectRefCacheEntry(cacheKey, value, configSignature)
    }
  }
  try {
    const stdout = await readRemoteUrl(
      {
        repoPath,
        connectionId,
        ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
        ...(localGitOptions.admissionTier ? { admissionTier: localGitOptions.admissionTier } : {})
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
    const partial = parseGitLabProjectRef(
      stdout,
      getGlabPartialHosts(connectionId, localGitOptions)
    )
    if (partial) {
      // Evidence from an unsettled discovery uses the same finite expiry and never remembers auth.
      publish(partial)
      return partial
    }
  } catch (error) {
    // Failed SSH and transient probes do not establish a stable non-GitLab remote.
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

export function glabRepoExecOptions(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): { cwd?: string; wslDistro?: string; admissionTier?: GitAdmissionTier } {
  return connectionId
    ? {}
    : {
        cwd: repoPath,
        ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
        ...(localGitOptions.admissionTier ? { admissionTier: localGitOptions.admissionTier } : {})
      }
}

export function glabHostnameArgs(
  projectRef: Pick<ProjectRef, 'host'> | null | undefined,
  connectionId?: string | null
): string[] {
  return connectionId && projectRef?.host ? ['--hostname', projectRef.host] : []
}

/** mr/issue commands reject --hostname; use GITLAB_HOST instead. */
export function glabHostEnvOptions(
  projectRef: Pick<ProjectRef, 'host'> | null | undefined,
  connectionId?: string | null
): { env?: NodeJS.ProcessEnv } {
  if (!connectionId || !projectRef?.host) {
    return {}
  }
  const env: NodeJS.ProcessEnv = { ...process.env, GITLAB_HOST: projectRef.host }
  if (process.platform === 'win32') {
    // Environment values cross wsl.exe only when named in WSLENV.
    addWslEnvKeys(env, ['GITLAB_HOST'])
  }
  return { env }
}

async function isGlabConfiguredForRemoteHost(
  repoPath: string,
  projectRef: Pick<ProjectRef, 'host'>,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<boolean> {
  // Share negative auth results per host across all repository identity misses.
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
