import type { WorkspaceAttachmentMutation } from '../../../shared/workspace-attachments/workspace-attachment-mutation'
import type { FolderWorkspaceCreateResult } from '../../../shared/folder-workspaces/folder-workspace-create'
import type { RuntimeGroupFolderCreateInput } from '../workspaces/creation/runtime-group-folder-setup'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import type { RuntimeStore } from '../construction/runtime-store-contract'
import type { RuntimeWorktreeLifecycleEvent } from '../workspaces/lifecycle/worktree-lifecycle-event'

export type RuntimeProjectGroupDependencies = {
  getStore: () => RuntimeStore | null
  // `connectionId` narrows twins by their SSH target; undefined keeps the plain selector.
  resolveRepo: (selector: string, connectionId?: string | null) => Promise<Repo>
  notifyReposChanged: () => void
  resolveFolderConnectionId: (workspace: FolderWorkspace) => string | null
  teardownFolderWorkspacePtys: (worktreeId: string, connectionId: string | null) => Promise<void>
  acquireFileWatcherRemoval: (
    path: string,
    connectionId?: string
  ) => Promise<{ finish(removed: boolean): Promise<void> }>
  cleanupRemovedFolderWorkspaceState: (worktreeId: string) => void | Promise<void>
  emitWorktreeLifecycle: (event: RuntimeWorktreeLifecycleEvent) => void
  finishFolderCreation?: (
    input: RuntimeGroupFolderCreateInput,
    group: ProjectGroup,
    workspace: FolderWorkspace
  ) => Promise<FolderWorkspaceCreateResult>
}

export type FolderWorkspaceUpdates = Partial<
  Pick<
    FolderWorkspace,
    | 'name'
    | 'folderPath'
    | 'linkedTask'
    | 'linkedItems'
    | 'linkedTaskSourceContext'
    | 'comment'
    | 'isArchived'
    | 'isUnread'
    | 'isPinned'
    | 'sortOrder'
    | 'manualOrder'
    | 'workspaceStatus'
    | 'createdWithAgent'
    | 'pendingFirstAgentMessageRename'
    | 'firstAgentMessageRenameError'
    | 'lastActivityAt'
    | 'diffComments'
  >
> &
  WorkspaceAttachmentMutation
