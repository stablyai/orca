import type { OrcaRuntimeService } from '../orca-runtime'
import { queueWorkspaceDelete } from '../workspaces/workspace-lifecycle-commands'
import { MultiRepoWorkspaceService } from './multi-repo-workspace-service'
import type { MultiRepoWorkspacePort } from './multi-repo-workspace-port'

export function createMultiRepoWorkspacePort(runtime: OrcaRuntimeService): MultiRepoWorkspacePort {
  return {
    requireStore: () => runtime.requireStore(),
    createProjectGroup: (input) => runtime.createProjectGroup(input),
    createFolderWorkspace: (input) => runtime.createFolderWorkspace(input),
    deleteFolderWorkspace: (id) => runtime.deleteFolderWorkspace(id),
    createWorktree: (args) => runtime.createManagedWorktree(args),
    removeWorktree: (worktreeId, removal) =>
      queueWorkspaceDelete(
        runtime,
        `id:${worktreeId}`,
        undefined,
        { ...removal, allowUnverifiedPtyStop: false },
        (queued) =>
          runtime.removeManagedWorktree(`id:${worktreeId}`, {
            ...queued,
            waitForBackgroundRemoval: true
          })
      ),
    listDetectedWorktrees: (repoId) => runtime.listDetectedManagedWorktrees(repoId),
    notifyChanged: () => runtime.publishReposChanged()
  }
}

const servicesByRuntime = new WeakMap<OrcaRuntimeService, MultiRepoWorkspaceService>()

export function getMultiRepoWorkspaceService(
  runtime: OrcaRuntimeService
): MultiRepoWorkspaceService {
  let service = servicesByRuntime.get(runtime)
  if (!service) {
    service = new MultiRepoWorkspaceService(createMultiRepoWorkspacePort(runtime))
    servicesByRuntime.set(runtime, service)
  }
  return service
}
