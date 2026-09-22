import { GitCapabilityCache } from '../../shared/git-capability-cache'
import type { SshGitProvider } from '../providers/ssh-git-provider'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  isWslLinkedWorktreeGitRoutingCandidate,
  prepareWslLinkedWorktreeGitRouting
} from './wsl-linked-worktree-git-routing'

type LocalGitCapabilityTarget = {
  cwd?: string
  wslDistro?: string
  signal?: AbortSignal
}

const localCapabilitiesByExecutionHost = new Map<string, GitCapabilityCache>()
const MAX_LOCAL_GIT_CAPABILITY_HOSTS = 128
// Why: reconnecting creates a new provider, while concurrent IPC/runtime users
// of one SSH connection must share the same remote Git capability results.
let sshCapabilitiesByProvider = new WeakMap<SshGitProvider, GitCapabilityCache>()

function getLocalGitExecutionHostKey(target: LocalGitCapabilityTarget): string {
  const wslDistro =
    target.wslDistro ?? (target.cwd ? parseWslUncPath(target.cwd)?.distro : undefined)
  return wslDistro ? `wsl:${wslDistro}` : 'local'
}

export function getLocalGitCapabilityCache(
  target: LocalGitCapabilityTarget = {}
): GitCapabilityCache {
  const executionHost = getLocalGitExecutionHostKey(target)
  let cache = localCapabilitiesByExecutionHost.get(executionHost)
  if (!cache) {
    cache = new GitCapabilityCache()
  }
  localCapabilitiesByExecutionHost.delete(executionHost)
  localCapabilitiesByExecutionHost.set(executionHost, cache)
  while (localCapabilitiesByExecutionHost.size > MAX_LOCAL_GIT_CAPABILITY_HOSTS) {
    const oldest = localCapabilitiesByExecutionHost.keys().next().value
    if (oldest === undefined) {
      break
    }
    localCapabilitiesByExecutionHost.delete(oldest)
  }
  return cache
}

export function withLocalGitCapabilityCacheForExecution<T>(
  target: LocalGitCapabilityTarget,
  run: (capabilities: GitCapabilityCache) => Promise<T>
): Promise<T> {
  if (!target.cwd || !isWslLinkedWorktreeGitRoutingCandidate(target.cwd, target.wslDistro)) {
    try {
      return run(getLocalGitCapabilityCache(target))
    } catch (error) {
      return Promise.reject(error)
    }
  }
  return prepareWslLinkedWorktreeGitRouting(target.cwd, target.wslDistro, {
    signal: target.signal
  }).then((usesHostGit) =>
    run(
      getLocalGitCapabilityCache(
        usesHostGit ? { cwd: target.cwd } : { cwd: target.cwd, wslDistro: target.wslDistro }
      )
    )
  )
}

export function getSshGitCapabilityCache(provider: SshGitProvider): GitCapabilityCache {
  let cache = sshCapabilitiesByProvider.get(provider)
  if (!cache) {
    cache = new GitCapabilityCache()
    sshCapabilitiesByProvider.set(provider, cache)
  }
  return cache
}

export function clearGitCapabilityStateForTests(): void {
  localCapabilitiesByExecutionHost.clear()
  sshCapabilitiesByProvider = new WeakMap()
}
