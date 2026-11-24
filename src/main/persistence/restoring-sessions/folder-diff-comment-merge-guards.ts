import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'

/**
 * A WSL move fences writes to its folders: the guard throws for a write it refuses, and answers
 * "drop" only for passive updates. A note write is never passive, so a drop is also a refusal.
 */
export function assertWslMoveNoteWriteAllowed(
  row: FolderWorkspace,
  shouldDrop: (row: FolderWorkspace) => boolean
): void {
  if (shouldDrop(row)) {
    throw new Error('folder_workspace_note_write_fenced')
  }
}
