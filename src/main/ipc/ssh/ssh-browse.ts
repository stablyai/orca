import { ipcMain } from 'electron'
import type { SshConnectionManager } from '../../ssh/connection/ssh-connection-manager'
import type { RemoteBrowseResult } from '../../ssh/filesystem/ssh-remote-directory-browse'

export function registerSshBrowseHandler(
  getConnectionManager: () => SshConnectionManager | null
): void {
  ipcMain.removeHandler('ssh:browseDir')

  ipcMain.handle(
    'ssh:browseDir',
    async (_event, args: { targetId: string; dirPath: string }): Promise<RemoteBrowseResult> => {
      const { browseSshDirectory } =
        await import('../../ssh/filesystem/ssh-remote-directory-browse')
      return browseSshDirectory(getConnectionManager(), args.targetId, args.dirPath)
    }
  )
}
