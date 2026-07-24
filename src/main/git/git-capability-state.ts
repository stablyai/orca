import { GitCapabilityCache } from '../../shared/git-capability-cache'
import { measureUtf8ByteLength } from '../../shared/utf8-byte-limits'
import { parseWslUncPath } from '../../shared/wsl-paths'

type LocalGitCapabilityTarget = {
  cwd?: string
  wslDistro?: string
}

export const LOCAL_GIT_CAPABILITY_HOST_MAX_ENTRIES = 64
export const LOCAL_GIT_CAPABILITY_HOST_KEY_MAX_BYTES = 4 * 1024
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
  if (
    measureUtf8ByteLength(executionHost, {
      stopAfterBytes: LOCAL_GIT_CAPABILITY_HOST_KEY_MAX_BYTES
    }).exceededLimit
  ) {
    return new GitCapabilityCache()
  }
  let cache = localCapabilitiesByExecutionHost.get(executionHost)
  if (!cache) {
    cache = new GitCapabilityCache()
    localCapabilitiesByExecutionHost.set(executionHost, cache)
    while (localCapabilitiesByExecutionHost.size > LOCAL_GIT_CAPABILITY_HOST_MAX_ENTRIES) {
      const oldestHost = localCapabilitiesByExecutionHost.keys().next().value
      if (oldestHost === undefined) {
        break
      }
      localCapabilitiesByExecutionHost.delete(oldestHost)
    }
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
