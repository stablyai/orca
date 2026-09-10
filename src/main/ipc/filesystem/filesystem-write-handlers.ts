import { ipcMain, shell } from 'electron'
import { lstat, writeFile } from 'node:fs/promises'
import type { SshMutationExpectation } from '../../../shared/ssh-types'
import { assertSshMutationExpectation } from '../../ssh/ssh-connection-generation'
import { requireSshFilesystemProvider } from '../../providers/ssh-filesystem-dispatch'
import { tryDeleteWslUncPath } from '../../wsl-unc-delete'
import { authorizeExternalPath, resolveAuthorizedPath } from '../filesystem-auth'
import { isENOENT } from '../filesystem-path-containment'
import { registerFilesystemMutationHandlers } from '../filesystem-mutations'
import type { FilesystemHandlerContext } from './filesystem-handler-context'

export function registerFilesystemWriteHandlers(context: FilesystemHandlerContext): void {
  const { store } = context

  ipcMain.handle(
    'fs:writeFile',
    async (
      _event,
      args: { filePath: string; content: string; connectionId?: string } & SshMutationExpectation
    ): Promise<void> => {
      assertSshMutationExpectation(
        args.connectionId,
        args.expectedSshTargetId,
        args.expectedSshConnectionGeneration,
        args.expectedExecutionHostId
      )
      if (args.connectionId) {
        const provider = requireSshFilesystemProvider(args.connectionId)
        return provider.writeFile(args.filePath, args.content)
      }
      const filePath = await resolveAuthorizedPath(args.filePath, store)
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
      await writeFile(filePath, args.content, 'utf-8')
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
        const provider = requireSshFilesystemProvider(args.connectionId)
        return provider.deletePath(args.targetPath, args.recursive)
      }
      // Why: preserve the symlink so we delete the link, not its target (realpath would trash the real file, possibly outside all roots).
      const targetPath = await resolveAuthorizedPath(args.targetPath, store, {
        preserveSymlink: true
      })
      // Why: WSL UNC targets have no Recycle Bin (shell.trashItem throws), so hard-delete via `rm` inside the distro (issue #6415).
      if (await tryDeleteWslUncPath(targetPath, { recursive: args.recursive })) {
        return
      }
      // Why: swallow ENOENT so an external delete racing this UI delete stays idempotent (design §7.1).
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

  ipcMain.handle('fs:authorizeExternalPath', (_event, args: { targetPath: string }): void => {
    authorizeExternalPath(args.targetPath)
  })
}
