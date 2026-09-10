import type {
  RuntimeGitCommandHost,
  RuntimeModelDiscoverySelector,
  RuntimeModelDiscoveryTarget
} from './runtime-git-command-target'

export async function resolveRuntimeModelDiscoveryTarget(
  host: RuntimeGitCommandHost,
  selector: RuntimeModelDiscoverySelector
): Promise<RuntimeModelDiscoveryTarget> {
  if (host.resolveRuntimeModelDiscoveryTarget) {
    return host.resolveRuntimeModelDiscoveryTarget(selector)
  }
  if (typeof selector !== 'string') {
    throw new Error('repo_model_discovery_unsupported')
  }
  const target = await host.resolveRuntimeGitTarget(selector)
  return {
    cwd: target.worktree.path,
    executionHostId: target.executionHostId,
    localGitOptions: target.localGitOptions
  }
}
