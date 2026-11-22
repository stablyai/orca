import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { GlobalSettings } from '../../../shared/settings/global-settings-types'
import { normalizeFolderWorkspaceName } from '../../../shared/folder-workspaces/folder-workspaces'
import { shouldAutoRenameWorkspaceTitle } from '../../../shared/settings/workspace-title-language'

/** Localized titles wait for the first task; otherwise only agent-started workspaces do. */
export function initialFolderWorkspaceTitlePending(
  settings: Partial<Pick<GlobalSettings, 'autoRenameBranchFromWork' | 'workspaceTitleLanguage'>>,
  input: Pick<FolderWorkspace, 'createdWithAgent' | 'pendingFirstAgentMessageRename'>
): Pick<FolderWorkspace, 'pendingFirstAgentMessageRename'> {
  return shouldAutoRenameWorkspaceTitle(settings) ||
    (input.pendingFirstAgentMessageRename === true && input.createdWithAgent)
    ? { pendingFirstAgentMessageRename: true }
    : {}
}

/** A title change is a manual name, so generation no longer replaces it. */
export function renameFolderWorkspace(workspace: FolderWorkspace, requestedName: string): void {
  const name = normalizeFolderWorkspaceName(requestedName, workspace.name)
  workspace.pendingFirstAgentMessageRename &&= name === workspace.name
  workspace.name = name
}
