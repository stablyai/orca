import { GitCapabilityCache } from '../../shared/git-capability-cache'
import { parseWslUncPath } from '../../shared/wsl-paths'

type LocalGitCapabilityTarget = {
  cwd?: string
  wslDistro?: string
}

const localCapabilitiesByExecutionHost = new Map<string, GitCapabilityCache>()
// Why: reconnecting creates a new provider, while concurrent IPC/runtime users
// of one SSH connection must share the same remote Git capability results.
let sshCapabilitiesByProvider = new WeakMap<object, GitCapabilityCache>()

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
    localCapabilitiesByExecutionHost.set(executionHost, cache)
  }
  return cache
}

export function getSshGitCapabilityCache(provider: object): GitCapabilityCache {
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
