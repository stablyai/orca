import { ipcMain } from 'electron'
import type { SshConnectionManager } from '../../ssh/ssh-connection-manager'
import { browseSshDirectory, type RemoteBrowseResult } from '../../ssh/ssh-remote-directory-browse'

export function registerSshBrowseHandler(
  getConnectionManager: () => SshConnectionManager | null
): void {
  ipcMain.removeHandler('ssh:browseDir')

  ipcMain.handle(
    'ssh:browseDir',
    (_event, args: { targetId: string; dirPath: string }): Promise<RemoteBrowseResult> =>
      browseSshDirectory(getConnectionManager(), args.targetId, args.dirPath)
  )
}
