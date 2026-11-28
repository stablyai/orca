import { app, ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../../lazy-ipc-handle-group'
import { constants } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { Store } from '../../../persistence/loading-store/store'
import {
  resolveDesktopAuthorizedPath,
  resolveLocalRenamePaths,
  resolveLocalRequestPath
} from '../access/local-file-access-resolution'
import type { LocalFileAccess } from '../../../../shared/file-access/local-file-access'
import { SshHostNotServedError } from '../../../providers/ssh-host-not-served-error'
import { resolveLocalDroppedPathsForAgent } from './dropped-path-resolution'
import type { SshMutationExpectation } from '../../../../shared/remote-runtime/ssh/ssh-types'
import { assertSshMutationExpectation } from '../../../ssh/connection/authority/ssh-connection-generation'
import { renameLocalPathSerializedByDestination } from '../../../filesystem/destination-serialized-local-rename'
import {
  assertNotExists,
  createLocalFile
} from '../../../filesystem/local-file-io/filesystem-create-path'
import type {
  ImportItemResult,
  ResolveDroppedPathsResult
} from '../../../../shared/file-import/filesystem-import-result'
import type {
  StagedRuntimeUploadSource as StagedExternalImportSource,
  RuntimeUploadFileStreamRequest
} from '../../../../shared/file-import/runtime-upload-staging-contract'
import { importOneSource } from '../imports/filesystem-import-local'
import {
  stagedRuntimeUploadByteLength,
  stageOneSourceForRuntimeUpload
} from '../imports/filesystem-runtime-upload-staging'
import { streamExternalFileToRuntime } from '../../runtime-transfers/runtime-upload-file-stream'
import { abortWhenRendererGone } from '../../renderer-requests/renderer-lifetime-abort'
import { sweepAbandonedRuntimeUploadTempPath } from '../../runtime-transfers/runtime-upload-temp-sweep'
import { resolveEnvironment } from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import { windowsFsPath } from '../../../wsl/filesystem/wsl-unc-drive-fs-path'

export function registerFilesystemMutationHandlers(
  store: Store,
  ipc: IpcHandleRegistrar = ipcMain
): void {
  ipc.handle(
    'fs:createFile',
    async (
      _event,
      args: { filePath: string; connectionId?: string } & SshMutationExpectation
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
      const filePath = windowsFsPath(await resolveDesktopAuthorizedPath(args.filePath, store))
      await createLocalFile(filePath)
    }
  )

  ipc.handle(
    'fs:createDir',
    async (
      _event,
      args: { dirPath: string; connectionId?: string } & SshMutationExpectation
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
      const dirPath = windowsFsPath(await resolveDesktopAuthorizedPath(args.dirPath, store))
      await assertNotExists(dirPath)
      await mkdir(dirPath, { recursive: true })
    }
  )

  // Cross-volume rename propagates EXDEV through IPC.
  ipc.handle(
    'fs:rename',
    async (
      _event,
      args: {
        oldPath: string
        newPath: string
        connectionId?: string
        access?: LocalFileAccess
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
      // Preserve both leaves: rename acts on directory entries, including links; opened documents can move outside project roots.
      const { from, to } = await resolveLocalRenamePaths(
        args.oldPath,
        args.newPath,
        args.access,
        store
      )
      await renameLocalPathSerializedByDestination(from, to)
    }
  )

  ipc.handle(
    'fs:copy',
    async (
      _event,
      args: {
        sourcePath: string
        destinationPath: string
        connectionId?: string
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
      const sourcePath = await resolveDesktopAuthorizedPath(args.sourcePath, store, {
        preserveSymlink: true
      })
      const destinationPath = await resolveDesktopAuthorizedPath(args.destinationPath, store, {
        preserveSymlink: true
      })
      await mkdir(dirname(windowsFsPath(destinationPath)), { recursive: true })
      // Keep deconflicted copy destinations exclusive against late collisions.
      await copyFile(
        windowsFsPath(sourcePath),
        windowsFsPath(destinationPath),
        constants.COPYFILE_EXCL
      )
    }
  )

  ipc.handle(
    'fs:importExternalPaths',
    async (
      _event,
      args: {
        sourcePaths: string[]
        destDir: string
        connectionId?: string
        ensureDir?: boolean
        access?: LocalFileAccess
      } & SshMutationExpectation
    ): Promise<{ results: ImportItemResult[] }> => {
      assertSshMutationExpectation(
        args.connectionId,
        args.expectedSshTargetId,
        args.expectedSshConnectionGeneration,
        args.expectedExecutionHostId
      )
      if (args.connectionId) {
        throw new SshHostNotServedError(args.connectionId)
      }

      // Authorize before copying; opened-document images may target that document's own folder.
      const resolvedDest = await resolveLocalRequestPath(
        args.destDir,
        args.access,
        store,
        'import-into'
      )

      const results: ImportItemResult[] = []
      const reservedNames = new Set<string>()

      for (const sourcePath of args.sourcePaths) {
        const result = await importOneSource(sourcePath, resolvedDest, reservedNames)
        results.push(result)
        if (result.status === 'imported') {
          reservedNames.add(basename(result.destPath))
        }
      }

      return { results }
    }
  )

  ipc.handle(
    'fs:stageExternalPathsForRuntimeUpload',
    async (
      _event,
      args: { sourcePaths: string[]; nameExtensionlessImages?: boolean }
    ): Promise<{ sources: StagedExternalImportSource[] }> => {
      const sources: StagedExternalImportSource[] = []
      // Apply the size ceiling across the whole drop, not separately to each source.
      let totalBytes = 0
      for (const sourcePath of args.sourcePaths) {
        const source = await stageOneSourceForRuntimeUpload(sourcePath, totalBytes, {
          nameExtensionlessImages: args.nameExtensionlessImages
        })
        totalBytes += stagedRuntimeUploadByteLength(source)
        sources.push(source)
      }
      return { sources }
    }
  )

  // Main owns handles and runtime sockets; renderer retains commit/rollback orchestration without file bytes.
  ipc.handle(
    'fs:uploadExternalFileToRuntime',
    async (event, args: RuntimeUploadFileStreamRequest): Promise<{ byteLength: number }> => {
      const userDataPath = app.getPath('userData')
      const lifetime = abortWhenRendererGone(event.sender)
      let request: RuntimeUploadFileStreamRequest | undefined
      try {
        request = {
          ...args,
          environmentId: (await resolveEnvironment(userDataPath, args.environmentId)).id
        }
        lifetime.signal.throwIfAborted()
        return await streamExternalFileToRuntime({
          ...request,
          userDataPath,
          signal: lifetime.signal
        })
      } catch (error) {
        if (lifetime.signal.aborted && request) {
          // The renderer cannot clean up its temp path after it disappears.
          await sweepAbandonedRuntimeUploadTempPath(userDataPath, request)
        }
        throw error
      } finally {
        lifetime.dispose()
      }
    }
  )

  // Terminal drops reference local paths in place; explorer imports copy into a picked destination.
  ipc.handle(
    'fs:resolveDroppedPathsForAgent',
    async (
      _event,
      args: {
        paths: string[]
        worktreePath: string
        connectionId?: string
      } & SshMutationExpectation
    ): Promise<ResolveDroppedPathsResult> => {
      assertSshMutationExpectation(
        args.connectionId,
        args.expectedSshTargetId,
        args.expectedSshConnectionGeneration,
        args.expectedExecutionHostId
      )
      // Empty connection IDs are errors; only null/undefined selects local routing.
      if (args.connectionId == null) {
        return {
          resolvedPaths: resolveLocalDroppedPathsForAgent(args.paths, args.worktreePath),
          skipped: [],
          failed: []
        }
      }
      throw new SshHostNotServedError(args.connectionId)
    }
  )
}
