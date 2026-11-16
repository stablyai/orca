import { dirname } from 'node:path'
import type { BrowserWindow, OpenDialogOptions } from 'electron'
import { ipcMain } from 'electron'
import type { Store } from '../../persistence/loading-store/store'
import { showSingleFlightOpenDialog } from '../single-flight-open-dialog'

export function registerRepoFolderPickerHandlers(mainWindow: BrowserWindow, store: Store): void {
  const pickOptions = (properties: OpenDialogOptions['properties']): OpenDialogOptions => {
    const lastDirectory = store.getUI().lastProjectPickerDirectory
    // A moved or deleted path is ignored by the OS dialog, which falls back to its default.
    return { properties, ...(lastDirectory ? { defaultPath: lastDirectory } : {}) }
  }
  const rememberPickedDirectory = (filePaths: string[]): void => {
    const directory = filePaths[0] ? dirname(filePaths[0]) : undefined
    if (directory && directory !== store.getUI().lastProjectPickerDirectory) {
      store.updateUI({ lastProjectPickerDirectory: directory })
    }
  }

  ipcMain.handle('repos:pickFolder', async () => {
    const result = await showSingleFlightOpenDialog(pickOptions(['openDirectory']), mainWindow)
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    rememberPickedDirectory(result.filePaths)
    return result.filePaths[0]
  })

  ipcMain.handle('repos:pickFolders', async () => {
    const result = await showSingleFlightOpenDialog(
      pickOptions(['openDirectory', 'multiSelections']),
      mainWindow
    )
    if (result.canceled || result.filePaths.length === 0) {
      return []
    }
    rememberPickedDirectory(result.filePaths)
    return result.filePaths
  })

  // Clone destinations need a generic picker because they may not contain a Git repo.
  ipcMain.handle('repos:pickDirectory', async () => {
    const result = await showSingleFlightOpenDialog(
      // macOS creates typed partial paths when directory creation is enabled; defer creation to submit.
      pickOptions(['openDirectory']),
      mainWindow
    )
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    rememberPickedDirectory(result.filePaths)
    return result.filePaths[0]
  })
}
