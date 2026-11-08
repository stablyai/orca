import type { RuntimeStore } from '../runtime-store-contract'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  assertUniqueFolderWorkspaceId,
  folderCatalogOf
} from '../workspaces/catalog/workspace-selector-candidates'

/** `requireUniqueId` refuses a folder id that several folder workspaces share, before any side effect. */
export type FolderWorkspaceMutationOptions = { requireUniqueId?: boolean }

export function assertUniqueIdWhenRequired(
  store: RuntimeStore,
  folderWorkspaceId: string,
  options: FolderWorkspaceMutationOptions
): void {
  if (options.requireUniqueId) {
    assertUniqueFolderWorkspaceId(
      folderCatalogOf(store),
      folderWorkspaceId,
      folderWorkspaceKey(folderWorkspaceId)
    )
  }
}
