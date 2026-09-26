import { posix, relative } from 'node:path'
import { BrowserWindow, dialog } from 'electron'
import type { Store } from '../persistence'
import { findFolderRepoAt } from './perforce-diff-routing'
import { getPerforceSettings, resolvePerforceBackend } from './perforce-ssh-backend'

export const PERFORCE_EDIT_DECLINED_MESSAGE =
  'Save cancelled: the file is not opened for edit in Perforce.'

async function confirmOpenForEdit(relativePath: string): Promise<boolean> {
  const options = {
    type: 'question' as const,
    buttons: ['Open for Edit', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: 'Open this file for edit in Perforce?',
    detail: `${relativePath} is not opened for edit. Saving requires opening it first.`
  }
  const parent = BrowserWindow.getFocusedWindow()
  const result = parent
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options)
  return result.response === 0
}

/**
 * Perforce leaves synced files read-only until they are opened for edit, so saving one
 * would fail with EACCES. Ask before opening it for edit; declining cancels the save.
 * Probe failures fall through to the normal write.
 */
export async function checkoutReadOnlyPerforceFileBeforeWrite(
  store: Store,
  connectionId: string | null | undefined,
  filePath: string
): Promise<void> {
  const behavior = getPerforceSettings().saveReadOnlyBehavior
  const repo = findFolderRepoAt(store, connectionId, filePath, { contains: true })
  if (!repo || behavior === 'never') {
    return
  }
  const relativePath = (connectionId ? posix.relative : relative)(repo.path, filePath)
  const backend = resolvePerforceBackend(connectionId)
  try {
    if (
      !(await backend.detect(repo.path)).isWorkspace ||
      !(await backend.isReadOnlyFile(repo.path, relativePath))
    ) {
      return
    }
  } catch {
    return
  }
  if (behavior === 'ask' && !(await confirmOpenForEdit(relativePath))) {
    throw new Error(PERFORCE_EDIT_DECLINED_MESSAGE)
  }
  try {
    await backend.checkoutIfReadOnly(repo.path, relativePath)
  } catch {
    // The writer reports the failure if the file stayed read-only.
  }
}
