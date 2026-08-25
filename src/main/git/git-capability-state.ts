import { GitCapabilityCache } from '../../shared/git-capability-cache'
import {
  gitExecutionHostForTarget,
  gitExecutionHostKey,
  type GitExecutionHostTarget
} from './git-execution-host'
import {
  isWslLinkedWorktreeGitRoutingCandidate,
  prepareWslLinkedWorktreeGitRouting
} from './wsl-linked-worktree-git-routing'

type LocalGitCapabilityTarget = GitExecutionHostTarget & { signal?: AbortSignal }

const localCapabilitiesByExecutionHost = new Map<string, GitCapabilityCache>()
// Why: reconnecting creates a new provider, while concurrent IPC/runtime users
// of one SSH connection must share the same remote Git capability results.
let sshCapabilitiesByProvider = new WeakMap<object, GitCapabilityCache>()

function getLocalGitExecutionHostKey(target: LocalGitCapabilityTarget): string {
  return gitExecutionHostKey(gitExecutionHostForTarget(target))
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
  }).then((usesHostGit) => run(getLocalGitCapabilityCache({ ...target, usesHostGit })))
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
