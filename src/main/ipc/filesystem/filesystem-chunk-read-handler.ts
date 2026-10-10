import { ipcMain } from 'electron'
import { readLocalFileRange } from './local-file-range-read'
import { validateFileRangeRequest } from '../../../shared/file-range-read'
import { requireSshFilesystemProvider } from '../../providers/ssh-filesystem-dispatch'
import { readSshFileExplorerChunk } from '../../runtime/ssh-file-explorer-chunk-read'
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
        const provider = requireSshFilesystemProvider(args.connectionId)
        const stats = await provider.stat(args.filePath)
        if (stats.type === 'directory') {
          throw new Error('Cannot read a directory')
        }
        return readSshFileExplorerChunk(
          provider,
          args.filePath,
          stats.size,
          args.offset,
          args.length
        )
      }
      const filePath = await resolveLocalFileRequestPath(args.filePath, args.access, store)
      return readLocalFileRange(filePath, args.offset, args.length)
    }
  )
}
