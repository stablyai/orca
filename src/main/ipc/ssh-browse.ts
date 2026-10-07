import { ipcMain } from 'electron'
import {
  browseSshDirectory,
  type RemoteBrowseResult,
  type SshBrowseConnection
} from '../ssh/ssh-directory-browse'

type SshBrowseManager = {
  getConnection: (targetId: string) => SshBrowseConnection | undefined
}

export function registerSshBrowseHandler(
  getConnectionManager: () => SshBrowseManager | null
): void {
  ipcMain.removeHandler('ssh:browseDir')
  ipcMain.handle(
    'ssh:browseDir',
    async (_event, args: { targetId: string; dirPath: string }): Promise<RemoteBrowseResult> => {
      const manager = getConnectionManager()
      if (!manager) {
        throw new Error('SSH connection manager not initialized')
      }
      const connection = manager.getConnection(args.targetId)
      if (!connection) {
        throw new Error(`SSH connection "${args.targetId}" not found`)
      }
      return await browseSshDirectory(connection, args.dirPath)
    }
  )
}
