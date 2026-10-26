import { ipcMain, shell } from 'electron'
import { lstat } from 'node:fs/promises'
import type { SshMutationExpectation } from '../../../shared/ssh-types'
import { assertSshMutationExpectation } from '../../ssh/connection/ssh-connection-generation'
import { SshHostNotServedError } from '../../providers/ssh-host-not-served-error'
import { tryDeleteWslUncPath } from '../../wsl-unc-delete'
import type { LocalFileAccess } from '../../../shared/local-file-access'
import {
  resolveDesktopAuthorizedPath,
  resolveLocalWriteRequestPath
} from '../local-file-access-resolution'
import { isENOENT } from './filesystem-path-containment'
import { registerFilesystemMutationHandlers } from './filesystem-mutations'
import { registerAgentSessionAttachmentUploadHandlers } from '../agent-session-attachment-upload-ipc'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import type {
  FileWriteDiskPrecondition,
  FileWriteResult
} from '../../../shared/file-write-disk-precondition'
import { writeLocalTextFileWithDiskPrecondition } from './local-disk-write-precondition'

export function registerFilesystemWriteHandlers(context: FilesystemHandlerContext): void {
  const { store } = context

  ipcMain.handle(
    'fs:writeFile',
    async (
      _event,
      args: {
        filePath: string
        content: string
        connectionId?: string
        access?: LocalFileAccess
        diskPrecondition?: FileWriteDiskPrecondition
      } & SshMutationExpectation
    ): Promise<FileWriteResult> => {
      assertSshMutationExpectation(
        args.connectionId,
        args.expectedSshTargetId,
        args.expectedSshConnectionGeneration,
        args.expectedExecutionHostId
      )
      if (args.connectionId) {
        throw new SshHostNotServedError(args.connectionId)
      }
      const filePath = await resolveLocalWriteRequestPath(args.filePath, args.access, store)
      try {
        const fileStats = await lstat(filePath)
        if (fileStats.isDirectory()) {
          throw new Error('Cannot write to a directory')
        }
      } catch (error) {
        if (!isENOENT(error)) {
          throw error
        }
      }
      return writeLocalTextFileWithDiskPrecondition(filePath, args.content, args.diskPrecondition)
    }
  )

  ipcMain.handle(
    'fs:deletePath',
    async (
      _event,
      args: {
        targetPath: string
        connectionId?: string
        recursive?: boolean
      } & SshMutationExpectation
    ): Promise<void> => {
      assertSshMutationExpectation(
        args.connectionId,
        args.expectedSshTargetId,
        args.expectedSshConnectionGeneration,
        args.expectedExecutionHostId
      )
      if (args.connectionId) {
        throw new SshHostNotServedError(args.connectionId)
      }
      // Delete the symlink entry, not a realpath target that may be outside allowed roots.
      const targetPath = await resolveDesktopAuthorizedPath(args.targetPath, store, {
        preserveSymlink: true
      })
      // WSL UNC has no Recycle Bin; hard-delete inside the distro (#6415).
      if (await tryDeleteWslUncPath(targetPath, { recursive: args.recursive })) {
        return
      }
      // Concurrent external deletion must leave UI deletion idempotent.
      try {
        await shell.trashItem(targetPath)
      } catch (error) {
        if (isENOENT(error)) {
          return
        }
        throw error
      }
    }
  )

  registerFilesystemMutationHandlers(store)
  registerAgentSessionAttachmentUploadHandlers()
}
