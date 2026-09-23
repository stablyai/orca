import type { BrowserWindow } from 'electron'
import { dialog, ipcMain } from 'electron'

type FolderPickerArgs = {
  /** Initial dialog directory (e.g. a WSL distro UNC root for distro-scoped picks). */
  defaultPath?: string
}

export function registerRepoFolderPickerHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle('repos:pickFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  ipcMain.handle('repos:pickFolders', async (_event, args?: FolderPickerArgs) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'multiSelections'],
      ...(args?.defaultPath ? { defaultPath: args.defaultPath } : {})
    })
    if (result.canceled || result.filePaths.length === 0) {
      return []
    }
    return result.filePaths
  })

  // Why: generic folder picker, separate from pickFolder's add-project flow; a clone destination may not be a git repo yet.
  ipcMain.handle('repos:pickDirectory', async (_event, args?: FolderPickerArgs) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      // Why: macOS materializes typed partial paths with directory creation on; clone/create make the final path on submit.
      properties: ['openDirectory'],
      ...(args?.defaultPath ? { defaultPath: args.defaultPath } : {})
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })
}
