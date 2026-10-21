import { ipcMain } from 'electron'
import { readLocalFileRange } from './local-file-range-read'
import { validateFileRangeRequest } from '../../../shared/file-range-read'
import { SshHostNotServedError } from '../../providers/ssh-host-not-served-error'
import { resolveLocalFileRequestPath } from '../local-file-access-resolution'
import type { LocalFileAccess } from '../../../shared/local-file-access'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

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
      }
    ) => {
      validateFileRangeRequest(args.offset, args.length)
      if (args.connectionId) {
        throw new SshHostNotServedError(args.connectionId)
      }
      const filePath = await resolveLocalFileRequestPath(args.filePath, args.access, store)
      return readLocalFileRange(filePath, args.offset, args.length)
    }
  )
}
