import { removeRuntimeUnregisteredWorktree } from '../runtime-unregistered-worktree-removal'
import { isLocalRuntimeWorktreePathMissing } from '../runtime-worktree-filesystem'
import { stopWorkspaceServersForRemoval } from '../../servers/workspace-server-removal'
import type { WorkspaceServerProcessManager } from '../../servers/workspace-server-process-manager'
import type { ExecutionHostId } from '../../../shared/execution-host'

/** Missing directories have no PTY sweep, but their managed child can still be alive. */
export async function removeUnregisteredWorkspaceWithServers(
  args: Parameters<typeof removeRuntimeUnregisteredWorktree>[0] & {
    workspaceServers: WorkspaceServerProcessManager
    removalHostId?: ExecutionHostId
  }
): ReturnType<typeof removeRuntimeUnregisteredWorktree> {
  if (
    (args.force || args.removedMeta) &&
    (await isLocalRuntimeWorktreePathMissing(args.target.path, args.localOptions))
  ) {
    await stopWorkspaceServersForRemoval(args, args.target.id, args.removalHostId)
  }
  return await removeRuntimeUnregisteredWorktree(args)
}
