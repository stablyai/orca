import type { BrowserWindow } from 'electron'
import { ipcMain } from 'electron'
import { showSingleFlightOpenDialog } from '../single-flight-open-dialog'

export function registerRepoFolderPickerHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle('repos:pickFolder', async () => {
    const result = await showSingleFlightOpenDialog(
      {
        properties: ['openDirectory']
      },
      mainWindow
    )
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle('repos:pickFolders', async () => {
    const result = await showSingleFlightOpenDialog(
      {
        properties: ['openDirectory', 'multiSelections']
      },
      mainWindow
    )
    if (result.canceled || result.filePaths.length === 0) {
      return []
    }
    return result.filePaths
  })

  // Clone destinations need a generic picker because they may not contain a Git repo.
  ipcMain.handle('repos:pickDirectory', async () => {
    const result = await showSingleFlightOpenDialog(
      {
        // macOS creates typed partial paths when directory creation is enabled; defer creation to submit.
        properties: ['openDirectory']
      },
      mainWindow
    )
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })
}
