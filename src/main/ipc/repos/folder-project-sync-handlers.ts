import { app, ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import {
  FolderProjectSetupRequest,
  FolderProjectSyncPreference,
  FolderProjectSyncTarget
} from '../../../shared/project/folder-project-sync'
import type { Store } from '../../persistence/loading-store/store'
import { DesktopFolderSync } from '../../workspaces/folder-sync/desktop-folder-sync'

export function registerFolderProjectSyncHandlers(window: BrowserWindow, store: Store): void {
  const userDataPath = app.getPath('userData')
  const profileDirectory = store.getProfileStorageDirectory()
  const sync = new DesktopFolderSync(userDataPath, join(profileDirectory, 'folder-sync.json'), () =>
    store.getRepos()
  )
  window.once('closed', () => sync.dispose())
  ipcMain.removeHandler('projectHostSetups:setupFolderReplica')
  ipcMain.removeHandler('projectHostSetups:getFolderSyncStatus')
  ipcMain.removeHandler('projectHostSetups:setFolderSyncPreference')
  ipcMain.handle('projectHostSetups:setupFolderReplica', (_event, args: unknown) =>
    sync.setup(FolderProjectSetupRequest.parse(args))
  )
  ipcMain.handle('projectHostSetups:getFolderSyncStatus', (_event, args: unknown) =>
    sync.getStatus(FolderProjectSyncTarget.parse(args))
  )
  ipcMain.handle('projectHostSetups:setFolderSyncPreference', (_event, args: unknown) =>
    sync.setPreference(FolderProjectSyncPreference.parse(args))
  )
}
