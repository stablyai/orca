import { ipcMain } from 'electron'
import { readdir, readFile, writeFile, stat } from 'fs/promises'
import { resolve } from 'path'
import type { Store } from '../persistence'
import type { DirEntry, GitStatusEntry, GitDiffResult } from '../../shared/types'
import { getStatus, getDiff, stageFile, unstageFile, discardChanges } from '../git/status'

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB

/**
 * Validate that a path is within a known worktree directory.
 */
function isPathAllowed(targetPath: string, store: Store): boolean {
  const resolvedTarget = resolve(targetPath)
  const repos = store.getRepos()

  for (const repo of repos) {
    // Allow paths within the repo itself
    if (
      resolvedTarget.startsWith(`${resolve(repo.path)}/`) ||
      resolvedTarget === resolve(repo.path)
    ) {
      return true
    }
  }

  // Also check the workspace directory from settings
  const settings = store.getSettings()
  if (settings.workspaceDir) {
    const resolvedWorkspace = resolve(settings.workspaceDir)
    if (
      resolvedTarget.startsWith(`${resolvedWorkspace}/`) ||
      resolvedTarget === resolvedWorkspace
    ) {
      return true
    }
  }

  return false
}

/**
 * Check if a buffer appears to be binary (contains null bytes in first 8KB).
 */
function isBinaryBuffer(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, 8192)
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) {
      return true
    }
  }
  return false
}

export function registerFilesystemHandlers(store: Store): void {
  // ─── Filesystem ─────────────────────────────────────────
  ipcMain.handle('fs:readDir', async (_event, args: { dirPath: string }): Promise<DirEntry[]> => {
    if (!isPathAllowed(args.dirPath, store)) {
      throw new Error('Access denied: path is outside allowed directories')
    }

    const entries = await readdir(args.dirPath, { withFileTypes: true })
    return entries
      .map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink()
      }))
      .sort((a, b) => {
        // Directories first, then alphabetical
        if (a.isDirectory !== b.isDirectory) {
          return a.isDirectory ? -1 : 1
        }
        return a.name.localeCompare(b.name)
      })
  })

  ipcMain.handle(
    'fs:readFile',
    async (_event, args: { filePath: string }): Promise<{ content: string; isBinary: boolean }> => {
      if (!isPathAllowed(args.filePath, store)) {
        throw new Error('Access denied: path is outside allowed directories')
      }

      const stats = await stat(args.filePath)
      if (stats.size > MAX_FILE_SIZE) {
        throw new Error(
          `File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`
        )
      }

      const buffer = await readFile(args.filePath)
      if (isBinaryBuffer(buffer)) {
        return { content: '', isBinary: true }
      }

      return { content: buffer.toString('utf-8'), isBinary: false }
    }
  )

  ipcMain.handle(
    'fs:writeFile',
    async (_event, args: { filePath: string; content: string }): Promise<void> => {
      if (!isPathAllowed(args.filePath, store)) {
        throw new Error('Access denied: path is outside allowed directories')
      }

      await writeFile(args.filePath, args.content, 'utf-8')
    }
  )

  ipcMain.handle(
    'fs:stat',
    async (
      _event,
      args: { filePath: string }
    ): Promise<{ size: number; isDirectory: boolean; mtime: number }> => {
      if (!isPathAllowed(args.filePath, store)) {
        throw new Error('Access denied: path is outside allowed directories')
      }

      const stats = await stat(args.filePath)
      return {
        size: stats.size,
        isDirectory: stats.isDirectory(),
        mtime: stats.mtimeMs
      }
    }
  )

  // ─── Git operations ─────────────────────────────────────
  ipcMain.handle(
    'git:status',
    async (_event, args: { worktreePath: string }): Promise<GitStatusEntry[]> => {
      return getStatus(args.worktreePath)
    }
  )

  ipcMain.handle(
    'git:diff',
    async (
      _event,
      args: { worktreePath: string; filePath: string; staged: boolean }
    ): Promise<GitDiffResult> => {
      return getDiff(args.worktreePath, args.filePath, args.staged)
    }
  )

  ipcMain.handle(
    'git:stage',
    async (_event, args: { worktreePath: string; filePath: string }): Promise<void> => {
      await stageFile(args.worktreePath, args.filePath)
    }
  )

  ipcMain.handle(
    'git:unstage',
    async (_event, args: { worktreePath: string; filePath: string }): Promise<void> => {
      await unstageFile(args.worktreePath, args.filePath)
    }
  )

  ipcMain.handle(
    'git:discard',
    async (_event, args: { worktreePath: string; filePath: string }): Promise<void> => {
      await discardChanges(args.worktreePath, args.filePath)
    }
  )
}
