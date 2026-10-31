import { ipcMain } from 'electron'
import { readLocalFileRange } from './local-file-range-read'
import { validateFileRangeRequest } from '../../../shared/file-range-read'
import { SshHostNotServedError } from '../../providers/ssh-host-not-served-error'
import { resolveLocalFileRequestPath } from '../local-file-access-resolution'
import type { LocalFileAccess } from '../../../shared/local-file-access'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import { guardWslUncPathAccess } from '../../wsl/wsl-unc-access-gate'

export function registerFilesystemChunkReadHandler({ store }: FilesystemHandlerContext): void {
  ipcMain.handle(
    'fs:readFileChunk',
    async (
      _event,
      args: {
        filePath: string
        connectionId?: string
        access?: LocalFileAccess
        offset: number
        length: number
        wakeWslDistro?: boolean
      }
    ) => {
      validateFileRangeRequest(args.offset, args.length)
      if (args.connectionId) {
        throw new SshHostNotServedError(args.connectionId)
      }
      return guardWslUncPathAccess(
        args.filePath,
        async () =>
          readLocalFileRange(
            await resolveLocalFileRequestPath(args.filePath, args.access, store),
            args.offset,
            args.length
          ),
        { wake: args.wakeWslDistro === true }
      )
    }
  )
}
