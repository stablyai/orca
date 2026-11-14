import type { ExecutionHostId } from '../../../shared/execution-host'
import { shortPluginBranchName } from '../../../shared/plugins/events/plugin-events'
import { resolveFilesystemRouteForHost } from '../../providers/execution-host-provider-dispatch'
import type { PluginCommandWorkspaceResolver } from './plugin-command-invocation'

export type PluginCommandWorkspaceSource = {
  resolveRuntimeFileTarget(selector: string): Promise<{
    worktree: { displayName: string; git: { path: string; branch: string } }
    executionHostId: ExecutionHostId
  }>
}

/** Workspace commands run in this process, so only folders on this computer or its SSH hosts
 *  resolve; a paired server's workspace, or one that is gone, does not. Folder workspaces too. */
export function pluginCommandWorkspaceResolver(
  runtime: PluginCommandWorkspaceSource
): PluginCommandWorkspaceResolver {
  return async (worktreeId) => {
    try {
      const { worktree, executionHostId } = await runtime.resolveRuntimeFileTarget(
        `id:${worktreeId}`
      )
      const route = resolveFilesystemRouteForHost(executionHostId)
      if (route.kind === 'runtime') {
        return null
      }
      return {
        path: worktree.git.path,
        displayName: worktree.displayName,
        branch: shortPluginBranchName(worktree.git.branch),
        host: route.kind
      }
    } catch {
      return null
    }
  }
}
