import { BrowserWindow, dialog, ipcMain } from 'electron'

export function registerRepoFolderPickerHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle('repos:pickFolder', async (event) => {
    const result = await dialog.showOpenDialog(
      BrowserWindow.fromWebContents(event.sender) ?? mainWindow,
      {
        properties: ['openDirectory']
      }
    )
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle('repos:pickFolders', async (event) => {
    const result = await dialog.showOpenDialog(
      BrowserWindow.fromWebContents(event.sender) ?? mainWindow,
      {
        properties: ['openDirectory', 'multiSelections']
      }
    )
    if (result.canceled || result.filePaths.length === 0) {
      return []
    }
    return result.filePaths
  })

  // Clone destinations need a generic picker because they may not contain a Git repo.
  ipcMain.handle('repos:pickDirectory', async (event) => {
    const result = await dialog.showOpenDialog(
      BrowserWindow.fromWebContents(event.sender) ?? mainWindow,
      {
        // macOS creates typed partial paths when directory creation is enabled; defer creation to submit.
        properties: ['openDirectory']
      }
    )
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })
}
