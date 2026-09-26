import { posix, relative } from 'node:path'
import type { Store } from '../persistence'
import { findFolderRepoAt } from './perforce-diff-routing'
import { resolvePerforceBackend } from './perforce-ssh-backend'

/**
 * Perforce leaves synced files read-only until they are opened for edit, so saving one
 * would fail with EACCES. Check the file out first; any failure falls through to the normal write.
 */
export async function checkoutReadOnlyPerforceFileBeforeWrite(
  store: Store,
  connectionId: string | null | undefined,
  filePath: string
): Promise<void> {
  const repo = findFolderRepoAt(store, connectionId, filePath, { contains: true })
  if (!repo) {
    return
  }
  try {
    const backend = resolvePerforceBackend(connectionId)
    if ((await backend.detect(repo.path)).isWorkspace) {
      await backend.checkoutIfReadOnly(
        repo.path,
        (connectionId ? posix.relative : relative)(repo.path, filePath)
      )
    }
  } catch {
    // Probe failures are the writer's to report.
  }
}
