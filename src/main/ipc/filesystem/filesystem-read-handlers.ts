import { ipcMain } from 'electron'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { DirEntry, MarkdownDocument } from '../../../shared/filesystem-entry-types'
import { sortDirEntries } from '../../../shared/file-name-sort'
import { requireSshFilesystemProvider } from '../../providers/ssh-filesystem-dispatch'
import { resolveRegisteredWorktreePath } from '../registered-worktree-roots-cache'
import { resolveAuthorizedPath } from '../filesystem-auth'
import { isENOENT } from '../filesystem-path-containment'
import { listMarkdownDocuments, markdownDocumentsFromRelativePaths } from '../markdown-documents'
import { recordCrashBreadcrumb } from '../../crash-reporting/crash-breadcrumb-store'
import { buildReadDirErrorBreadcrumb, type ReadDirThrowSite } from '../readdir-error-diagnostics'
import type { FilesystemHandlerContext } from './filesystem-handler-context'
import {
  BINARY_PROBE_BYTES,
  isBinaryBuffer,
  isBinaryFilePrefix,
  isDirectoryEntry,
  MAX_PREVIEWABLE_BINARY_SIZE,
  MAX_TEXT_FILE_SIZE,
  PREVIEWABLE_BINARY_MIME_TYPES,
  readLocalLogSnapshot
} from './filesystem-file-content-inspection'

export function registerFilesystemReadHandlers(context: FilesystemHandlerContext): void {
  const { store } = context

  ipcMain.handle(
    'fs:readDir',
    async (_event, args: { dirPath: string; connectionId?: string }): Promise<DirEntry[]> => {
      // Why: fs:readDir throws surface as opaque IPC errors; record the throw site + redacted path shape to keep them diagnosable.
      let throwSite: ReadDirThrowSite = 'authorize'
      try {
        if (args.connectionId) {
          throwSite = 'ssh-provider'
          const provider = requireSshFilesystemProvider(args.connectionId)
          // Why: re-sort locally — the remote relay may be an older build with lexicographic ordering.
          return sortDirEntries(await provider.readDir(args.dirPath))
        }
        const dirPath = await resolveAuthorizedPath(args.dirPath, store)
        throwSite = 'readdir'
        const entries = await readdir(dirPath, { withFileTypes: true })
        const mapped = entries.map((entry) => ({
          name: entry.name,
          isDirectory: isDirectoryEntry(entry),
          isSymlink: entry.isSymbolicLink()
        }))
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
      _event,
      args: { filePath: string; connectionId?: string; includeLocalLogMetadata?: boolean }
    ): Promise<{
      content: string
      isBinary: boolean
      isImage?: boolean
      mimeType?: string
      fileIdentity?: string
    }> => {
      if (args.connectionId) {
        const provider = requireSshFilesystemProvider(args.connectionId)
        return provider.readFile(args.filePath)
      }
      const filePath = await resolveAuthorizedPath(args.filePath, store)
      if (args.includeLocalLogMetadata === true) {
        return readLocalLogSnapshot(filePath)
      }
      const stats = await stat(filePath)
      const mimeType = PREVIEWABLE_BINARY_MIME_TYPES[extname(filePath).toLowerCase()]
      const sizeLimit = mimeType ? MAX_PREVIEWABLE_BINARY_SIZE : MAX_TEXT_FILE_SIZE
      if (stats.size > sizeLimit) {
        throw new Error(
          `File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds ${sizeLimit / 1024 / 1024}MB limit`
        )
      }

      if (mimeType) {
        const buffer = await readFile(filePath)
        return {
          content: buffer.toString('base64'),
          isBinary: true,
          // Why: the renderer keys previewable-binary rendering off `isImage`, so set it for PDFs too to stay compatible.
          isImage: true,
          mimeType
        }
      }

      // Why: probe large unknown files first so archives aren't fully buffered only to discover they aren't editable text.
      if (stats.size > BINARY_PROBE_BYTES && (await isBinaryFilePrefix(filePath))) {
        return { content: '', isBinary: true }
      }

      const buffer = await readFile(filePath)
      if (isBinaryBuffer(buffer)) {
        return { content: '', isBinary: true }
      }
      return { content: buffer.toString('utf-8'), isBinary: false }
    }
  )

  ipcMain.handle(
    'fs:listMarkdownDocuments',
    async (
      _event,
      args: { rootPath: string; connectionId?: string }
    ): Promise<MarkdownDocument[]> => {
      if (args.connectionId) {
        const provider = requireSshFilesystemProvider(args.connectionId)
        const relativePaths = await provider.listFiles(args.rootPath)
        return markdownDocumentsFromRelativePaths(args.rootPath, relativePaths)
      }
      const rootPath = await resolveRegisteredWorktreePath(args.rootPath, store)
      return listMarkdownDocuments(rootPath)
    }
  )

  ipcMain.handle(
    'fs:stat',
    async (
      _event,
      args: { filePath: string; connectionId?: string }
    ): Promise<{ size: number; isDirectory: boolean; mtime: number }> => {
      if (args.connectionId) {
        const provider = requireSshFilesystemProvider(args.connectionId)
        const result = await provider.stat(args.filePath)
        return { size: result.size, isDirectory: result.type === 'directory', mtime: result.mtime }
      }
      const filePath = await resolveAuthorizedPath(args.filePath, store)
      const stats = await stat(filePath)
      return { size: stats.size, isDirectory: stats.isDirectory(), mtime: stats.mtimeMs }
    }
  )

  ipcMain.handle(
    'fs:pathExists',
    async (_event, args: { filePath: string; connectionId?: string }): Promise<boolean> => {
      try {
        if (args.connectionId) {
          const provider = requireSshFilesystemProvider(args.connectionId)
          await provider.stat(args.filePath)
          return true
        }
        const filePath = await resolveAuthorizedPath(args.filePath, store)
        await stat(filePath)
        return true
      } catch (error) {
        if (isENOENT(error)) {
          return false
        }
        throw error
      }
    }
  )
}
