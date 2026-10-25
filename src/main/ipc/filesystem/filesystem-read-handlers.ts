import { classifyFilesystemDirectoryEntries } from './filesystem-symlink-directory-entries'
import { markdownDocumentsFromRelativePaths } from '../../../shared/markdown-document-paths'
import {
  capturePathExistence,
  validatePathExistenceBatch,
  type PathExistenceResult
} from '../../../shared/path-existence-batch'
import { ipcMain } from 'electron'
import { readdir, stat } from 'node:fs/promises'
import type { DirEntry, MarkdownDocument } from '../../../shared/filesystem-entry-types'
import { sortDirEntries } from '../../../shared/file-name-sort'
import { SshHostNotServedError } from '../../providers/ssh-host-not-served-error'
import { resolveRegisteredWorktreePath } from '../registered-worktree-roots-cache'
import type { LocalFileAccess } from '../../../shared/local-file-access'
import {
  resolveDesktopAuthorizedPath,
  resolveLocalFileRequestPath
} from '../local-file-access-resolution'
import { isPathAbsentError } from './filesystem-path-containment'
import { listMarkdownDocuments } from '../markdown-documents'
import { getLocalGitOptionsForRegisteredWorktree } from '../local-worktree-runtime-options'
import { recordCrashBreadcrumb } from '../../crash-reporting/crash-breadcrumb-store'
import { buildReadDirErrorBreadcrumb, type ReadDirThrowSite } from '../readdir-error-diagnostics'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import { registerFilesystemChunkReadHandler } from './filesystem-chunk-read-handler'
import { readMediaPreview } from '../../media/media-preview-protocol'
import {
  readLocalFileContent,
  readLocalLogSnapshot,
  type LocalFileContent
} from './filesystem-file-content-inspection'

export function registerFilesystemReadHandlers(context: FilesystemHandlerContext): void {
  registerFilesystemChunkReadHandler(context)
  const { store } = context

  ipcMain.handle(
    'fs:readDir',
    async (
      _event,
      args: { dirPath: string; connectionId?: string; followSymlinks?: boolean }
    ): Promise<DirEntry[]> => {
      // Record throw site and redacted path shape because fs:readDir IPC errors otherwise lack context.
      let throwSite: ReadDirThrowSite = 'authorize'
      try {
        if (args.connectionId) {
          throwSite = 'ssh-provider'
          throw new SshHostNotServedError(args.connectionId)
        }
        const dirPath = await resolveDesktopAuthorizedPath(args.dirPath, store)
        throwSite = 'readdir'
        const entries = await readdir(dirPath, { withFileTypes: true })
        const mapped = await classifyFilesystemDirectoryEntries(
          args.dirPath,
          entries,
          args.followSymlinks ?? store.getSettings().followSymlinkedDirectories ?? false,
          (path) => resolveDesktopAuthorizedPath(path, store)
        )
        return sortDirEntries(mapped)
      } catch (error: unknown) {
        recordCrashBreadcrumb(
          'fs_readdir_error',
          buildReadDirErrorBreadcrumb({
            dirPath: args.dirPath,
            connectionId: args.connectionId,
            throwSite,
            error
          })
        )
        throw error
      }
    }
  )

  ipcMain.handle(
    'fs:readFile',
    async (
      event,
      args: {
        filePath: string
        connectionId?: string
        includeLocalLogMetadata?: boolean
        access?: LocalFileAccess
      }
    ): Promise<LocalFileContent> => {
      if (args.connectionId) {
        throw new SshHostNotServedError(args.connectionId)
      }
      const filePath = await resolveLocalFileRequestPath(args.filePath, args.access, store)
      const media = readMediaPreview(event, args, store)
      if (media) {
        return media
      }
      return args.includeLocalLogMetadata === true
        ? readLocalLogSnapshot(filePath)
        : readLocalFileContent(filePath)
    }
  )

  ipcMain.handle(
    'fs:listMarkdownDocuments',
    async (
      _event,
      args: { rootPath: string; connectionId?: string }
    ): Promise<MarkdownDocument[]> => {
      if (args.connectionId) {
        throw new SshHostNotServedError(args.connectionId)
      }
      const isFolderRoot = store
        .getFolderWorkspaces?.()
        .some((workspace) => workspace.folderPath === args.rootPath)
      const rootPath = isFolderRoot
        ? await resolveDesktopAuthorizedPath(args.rootPath, store)
        : await resolveRegisteredWorktreePath(args.rootPath, store)
      const documents = await listMarkdownDocuments(
        rootPath,
        getLocalGitOptionsForRegisteredWorktree(store, args.rootPath, rootPath)
      )
      return rootPath === args.rootPath
        ? documents
        : markdownDocumentsFromRelativePaths(
            args.rootPath,
            documents.map((document) => document.relativePath)
          )
    }
  )

  ipcMain.handle(
    'fs:stat',
    async (
      _event,
      args: { filePath: string; connectionId?: string; access?: LocalFileAccess }
    ): Promise<{ size: number; isDirectory: boolean; mtime: number }> => {
      if (args.connectionId) {
        throw new SshHostNotServedError(args.connectionId)
      }
      const filePath = await resolveLocalFileRequestPath(args.filePath, args.access, store)
      const stats = await stat(filePath)
      return { size: stats.size, isDirectory: stats.isDirectory(), mtime: stats.mtimeMs }
    }
  )

  ipcMain.handle(
    'fs:pathsExist',
    async (
      _event,
      args: { filePaths: string[]; connectionId?: string }
    ): Promise<PathExistenceResult[]> => {
      validatePathExistenceBatch(args.filePaths)
      if (args.connectionId) {
        throw new SshHostNotServedError(args.connectionId)
      }
      return Promise.all(
        args.filePaths.map((filePath) =>
          capturePathExistence(async () => {
            try {
              await stat(await resolveDesktopAuthorizedPath(filePath, store))
              return true
            } catch (error) {
              if (isPathAbsentError(error)) {
                return false
              }
              throw error
            }
          })
        )
      )
    }
  )

  ipcMain.handle(
    'fs:pathExists',
    async (
      _event,
      args: { filePath: string; connectionId?: string; access?: LocalFileAccess }
    ): Promise<boolean> => {
      try {
        if (args.connectionId) {
          throw new SshHostNotServedError(args.connectionId)
        }
        const filePath = await resolveLocalFileRequestPath(args.filePath, args.access, store)
        await stat(filePath)
        return true
      } catch (error) {
        if (isPathAbsentError(error)) {
          return false
        }
        throw error
      }
    }
  )
}
