import type { RuntimeStore } from '../construction/runtime-store-contract'
import type { FolderDiffCommentMergeHost } from '../../../shared/file-review/folder-diff-comment-merge-operation'
import { runtimeVisibleFolderWorkspaces } from '../workspaces/catalog/runtime-visible-catalog'
import {
  isLocalWslMoveRow,
  shouldDropWslMoveProjectUpdate
} from '../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'
import { assertWslMoveNoteWriteAllowed } from '../../persistence/restoring-sessions/folder-diff-comment-merge-guards'

/** The paired runtime's store as a merge-only note host, with the same guards its folder updates use. */
export function runtimeFolderDiffCommentMergeHost(
  store: RuntimeStore,
  notify: () => void
): FolderDiffCommentMergeHost {
  return {
    rows: () => store.getFolderWorkspaces?.() ?? [],
    visibleRows: () => runtimeVisibleFolderWorkspaces(store),
    assertWritable: (row) =>
      assertWslMoveNoteWriteAllowed(row, (target) =>
        isLocalWslMoveRow(target)
          ? shouldDropWslMoveProjectUpdate(
              store,
              { folderWorkspaceId: target.id },
              {
                diffComments: []
              }
            )
          : false
      ),
    update: (folderWorkspaceId, updates) =>
      store.updateFolderWorkspace?.(folderWorkspaceId, updates) ?? null,
    notify
  }
}
