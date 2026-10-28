import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type {
  CreateWorktreeResult,
  RemoveWorktreeResult
} from '../../../shared/worktree/create-types'
import type { DetectedWorktreeListResult } from '../../../shared/worktree/types'
import type { RuntimeManagedWorktreeCreateArgs } from '../runtime-managed-worktree-create-types'
import type { RuntimeStore } from '../runtime-store-contract'

export type MultiRepoWorktreeRemoval = {
  force: boolean
  runHooks: boolean
  allowFailedArchiveHook: boolean
}

/** Everything the multi-repo service needs from the runtime; keeps it testable without the runtime class chain. */
export type MultiRepoWorkspacePort = {
  requireStore(): RuntimeStore
  createProjectGroup(input: {
    name: string
    parentPath: string
    createdFrom: ProjectGroup['createdFrom']
  }): Promise<ProjectGroup>
  createFolderWorkspace(input: {
    projectGroupId: string
    name: string
    folderPath: string
    connectionId: null
    creatorProvenance?: FolderWorkspace['creatorProvenance']
    createdWithAgent?: FolderWorkspace['createdWithAgent']
  }): Promise<FolderWorkspace>
  deleteFolderWorkspace(folderWorkspaceId: string): Promise<{ deleted: boolean }>
  createWorktree(args: RuntimeManagedWorktreeCreateArgs): Promise<CreateWorktreeResult>
  removeWorktree(
    worktreeId: string,
    removal: MultiRepoWorktreeRemoval
  ): Promise<RemoveWorktreeResult>
  listDetectedWorktrees(repoId: string): Promise<DetectedWorktreeListResult>
  notifyChanged(): void
}
