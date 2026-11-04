import type { OpenNativeOwnerRemovalStore } from './workspaces/canonical-owner-removal'
import type { WorkspaceAttachmentMutation } from '../../shared/workspace-attachment-mutation'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeWorktreeLifecycleEvent } from './orca-runtime-core'

export type RuntimeProjectGroupDependencies = {
  openNativeOwnerStore?: OpenNativeOwnerRemovalStore
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
  cleanupRemovedFolderWorkspaceState: (worktreeId: string) => void
  emitWorktreeLifecycle: (event: RuntimeWorktreeLifecycleEvent) => void
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
