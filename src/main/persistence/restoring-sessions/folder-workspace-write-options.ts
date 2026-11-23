import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import {
  type StateWriteOptions,
  withUnreadStateHint,
  workspaceLinkWriteOptions
} from '../loading-store/profile-writing/write-scheduling'

/** What one folder workspace update tells write observers about its links and unread flags. */
export function folderWorkspaceWriteOptions(
  workspace: FolderWorkspace,
  updates: Partial<Pick<FolderWorkspace, 'externalConversations' | 'sortOrder' | 'name'>>,
  previous: Pick<FolderWorkspace, 'isUnread' | 'isArchived' | 'folderPath'>
): StateWriteOptions | undefined {
  const linkOptions = workspaceLinkWriteOptions(
    { worktreeId: folderWorkspaceKey(workspace.id), sshHostId: null },
    'externalConversations' in updates,
    workspace.externalConversations,
    updates.sortOrder === undefined && updates.name === undefined
  )
  // A retired source server's folders are hidden by path, so a move can change the count.
  return previous.folderPath === workspace.folderPath
    ? withUnreadStateHint(linkOptions, previous, workspace)
    : linkOptions
}
