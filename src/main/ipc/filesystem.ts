/* eslint-disable max-lines */
import { ipcMain, shell } from 'electron'
import { readdir, readFile, writeFile, stat, lstat } from 'fs/promises'
import { extname, relative } from 'path'
import type { ChildProcess } from 'child_process'
import { wslAwareSpawn } from '../git/runner'
import { parseWslPath, toWindowsWslPath } from '../wsl'
import type { Store } from '../persistence'
import type {
  DirEntry,
  GitBranchCompareResult,
  GitConflictOperation,
  GitDiffResult,
  GitStatusResult,
  SearchOptions,
  SearchResult,
  SearchFileResult
} from '../../shared/types'
import {
  getStatus,
  detectConflictOperation,
  getDiff,
  stageFile,
  unstageFile,
  bulkStageFiles,
  bulkUnstageFiles,
  discardChanges,
  getBranchCompare,
  getBranchDiff
} from '../git/status'
import { getRemoteFileUrl } from '../git/repo'
import {
  resolveAuthorizedPath,
  resolveRegisteredWorktreePath,
  validateGitRelativeFilePath,
  isENOENT,
  authorizeExternalPath,
  rebuildAuthorizedRootsCache
} from './filesystem-auth'
import { listQuickOpenFiles } from './filesystem-list-files'
import { registerFilesystemMutationHandlers } from './filesystem-mutations'
import { searchWithGitGrep } from './filesystem-search-git'
import { checkRgAvailable } from './rg-availability'

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
const DEFAULT_SEARCH_MAX_RESULTS = 2000
const MAX_MATCHES_PER_FILE = 100
const SEARCH_TIMEOUT_MS = 15000
const PREVIEWABLE_BINARY_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
}

function normalizeRelativePath(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/^\/+/, '')
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
  void rebuildAuthorizedRootsCache(store)
  const activeTextSearches = new Map<string, ChildProcess>()

  // ─── Filesystem ─────────────────────────────────────────
  ipcMain.handle('fs:readDir', async (_event, args: { dirPath: string }): Promise<DirEntry[]> => {
    const dirPath = await resolveAuthorizedPath(args.dirPath, store)
    const entries = await readdir(dirPath, { withFileTypes: true })
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
    async (
      _event,
      args: { filePath: string }
    ): Promise<{ content: string; isBinary: boolean; isImage?: boolean; mimeType?: string }> => {
      const filePath = await resolveAuthorizedPath(args.filePath, store)
      const stats = await stat(filePath)
      if (stats.size > MAX_FILE_SIZE) {
        throw new Error(
          `File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`
        )
      }

      const buffer = await readFile(filePath)
      const mimeType = PREVIEWABLE_BINARY_MIME_TYPES[extname(filePath).toLowerCase()]
      if (mimeType) {
        return {
          content: buffer.toString('base64'),
          isBinary: true,
          // Why: the renderer/store contract already keys previewable binary
          // rendering off `isImage`. Keep that legacy flag for PDFs too so the
          // new preview path stays compatible with existing callers.
          isImage: true,
          mimeType
        }
      }

      if (isBinaryBuffer(buffer)) {
        return { content: '', isBinary: true }
      }

      return { content: buffer.toString('utf-8'), isBinary: false }
    }
  )

  ipcMain.handle(
    'fs:writeFile',
    async (_event, args: { filePath: string; content: string }): Promise<void> => {
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

  ipcMain.handle('fs:deletePath', async (_event, args: { targetPath: string }): Promise<void> => {
    const targetPath = await resolveAuthorizedPath(args.targetPath, store)

    // Why: once auto-refresh exists, an external delete can race with a
    // UI-initiated delete. Swallowing ENOENT keeps the action idempotent
    // from the user's perspective (design §7.1).
    try {
      await shell.trashItem(targetPath)
    } catch (error) {
      if (isENOENT(error)) {
        return
      }
      throw error
    }
  })

  registerFilesystemMutationHandlers(store)

  ipcMain.handle('fs:authorizeExternalPath', (_event, args: { targetPath: string }): void => {
    authorizeExternalPath(args.targetPath)
  })

  ipcMain.handle(
    'fs:stat',
    async (
      _event,
      args: { filePath: string }
    ): Promise<{ size: number; isDirectory: boolean; mtime: number }> => {
      const filePath = await resolveAuthorizedPath(args.filePath, store)
      const stats = await stat(filePath)
      return {
        size: stats.size,
        isDirectory: stats.isDirectory(),
        mtime: stats.mtimeMs
      }
    }
  )

  // ─── Search ────────────────────────────────────────────
  ipcMain.handle('fs:search', async (event, args: SearchOptions): Promise<SearchResult> => {
    const rootPath = await resolveAuthorizedPath(args.rootPath, store)
    const maxResults = Math.max(
      1,
      Math.min(args.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS, DEFAULT_SEARCH_MAX_RESULTS)
    )
    const searchKey = `${event.sender.id}:${rootPath}`

    // Why: checking rg availability upfront avoids a race condition where
    // spawn('rg') emits 'close' before 'error' on some platforms, causing
    // the handler to resolve with empty results before the git-grep
    // fallback can run. The result is cached after the first check.
    const rgAvailable = await checkRgAvailable(rootPath)
    if (!rgAvailable) {
      return searchWithGitGrep(rootPath, args, maxResults)
    }

    return new Promise((resolvePromise) => {
      const rgArgs: string[] = [
        '--json',
        '--hidden',
        '--glob',
        '!.git',
        '--max-count',
        String(MAX_MATCHES_PER_FILE),
        '--max-filesize',
        `${Math.floor(MAX_FILE_SIZE / 1024 / 1024)}M`
      ]

      if (!args.caseSensitive) {
        rgArgs.push('--ignore-case')
      }
      if (args.wholeWord) {
        rgArgs.push('--word-regexp')
      }
      if (!args.useRegex) {
        rgArgs.push('--fixed-strings')
      }
      if (args.includePattern) {
        for (const pat of args.includePattern
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)) {
          rgArgs.push('--glob', pat)
        }
      }
      if (args.excludePattern) {
        for (const pat of args.excludePattern
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)) {
          rgArgs.push('--glob', `!${pat}`)
        }
      }

      rgArgs.push('--', args.query, rootPath)

      // Why: search requests are fired on each query/options change. If the
      // previous ripgrep process keeps running, it can continue streaming and
      // parsing thousands of matches on the Electron main thread after the UI
      // no longer cares about that result, which is exactly the freeze users
      // experience in large repos.
      activeTextSearches.get(searchKey)?.kill()

      const fileMap = new Map<string, SearchFileResult>()
      let totalMatches = 0
      let truncated = false
      let stdoutBuffer = ''
      let resolved = false
      let child: ChildProcess | null = null

      const resolveOnce = (): void => {
        if (resolved) {
          return
        }
        resolved = true
        if (activeTextSearches.get(searchKey) === child) {
          activeTextSearches.delete(searchKey)
        }
        clearTimeout(killTimeout)
        resolvePromise({
          files: Array.from(fileMap.values()),
          totalMatches,
          truncated
        })
      }

      const processLine = (line: string): void => {
        if (!line || totalMatches >= maxResults) {
          return
        }

        try {
          const msg = JSON.parse(line)
          if (msg.type !== 'match') {
            return
          }

          const data = msg.data
          // Why: when rg runs inside WSL, output paths are Linux-native
          // (e.g. /home/user/repo/src/file.ts). Translate them back to
          // Windows UNC paths so path.relative() and Node fs APIs work.
          const wslInfo = parseWslPath(rootPath)
          const absPath: string = wslInfo
            ? toWindowsWslPath(data.path.text, wslInfo.distro)
            : data.path.text
          const relPath = normalizeRelativePath(relative(rootPath, absPath))

          let fileResult = fileMap.get(absPath)
          if (!fileResult) {
            fileResult = { filePath: absPath, relativePath: relPath, matches: [] }
            fileMap.set(absPath, fileResult)
          }

          for (const sub of data.submatches) {
            fileResult.matches.push({
              line: data.line_number,
              column: sub.start + 1,
              matchLength: sub.end - sub.start,
              lineContent: data.lines.text.replace(/\n$/, '')
            })
            totalMatches++
            if (totalMatches >= maxResults) {
              truncated = true
              child?.kill()
              break
            }
          }
        } catch {
          // skip malformed JSON lines
        }
      }

      const nextChild = wslAwareSpawn('rg', rgArgs, {
        cwd: rootPath,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      child = nextChild
      activeTextSearches.set(searchKey, nextChild)

      nextChild.stdout!.setEncoding('utf-8')
      nextChild.stdout!.on('data', (chunk: string) => {
        stdoutBuffer += chunk
        const lines = stdoutBuffer.split('\n')
        stdoutBuffer = lines.pop() ?? ''
        for (const line of lines) {
          processLine(line)
        }
      })
      nextChild.stderr!.on('data', () => {
        // Drain stderr so rg cannot block on a full pipe.
      })

      nextChild.once('error', () => {
        resolveOnce()
      })

      nextChild.once('close', () => {
        if (stdoutBuffer) {
          processLine(stdoutBuffer)
        }
        resolveOnce()
      })

      // Why: if the timeout fires, the child is killed and results are partial.
      // We must mark them as truncated so the UI can indicate incomplete results.
      const killTimeout = setTimeout(() => {
        truncated = true
        child?.kill()
      }, SEARCH_TIMEOUT_MS)
    })
  })

  // ─── List all files (for quick-open) ─────────────────────
  ipcMain.handle(
    'fs:listFiles',
    async (_event, args: { rootPath: string }): Promise<string[]> =>
      listQuickOpenFiles(args.rootPath, store)
  )

  // ─── Git operations ─────────────────────────────────────
  ipcMain.handle(
    'git:status',
    async (_event, args: { worktreePath: string }): Promise<GitStatusResult> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      return getStatus(worktreePath)
    }
  )

  // Why: lightweight fs-only check for conflict operation state. Used to poll
  // non-active worktrees so their "Rebasing"/"Merging" badges clear when the
  // operation finishes, without running a full `git status`.
  ipcMain.handle(
    'git:conflictOperation',
    async (_event, args: { worktreePath: string }): Promise<GitConflictOperation> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      return detectConflictOperation(worktreePath)
    }
  )

  ipcMain.handle(
    'git:diff',
    async (
      _event,
      args: { worktreePath: string; filePath: string; staged: boolean }
    ): Promise<GitDiffResult> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      return getDiff(worktreePath, filePath, args.staged)
    }
  )

  ipcMain.handle(
    'git:branchCompare',
    async (
      _event,
      args: { worktreePath: string; baseRef: string }
    ): Promise<GitBranchCompareResult> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      return getBranchCompare(worktreePath, args.baseRef)
    }
  )

  ipcMain.handle(
    'git:branchDiff',
    async (
      _event,
      args: {
        worktreePath: string
        compare: {
          baseRef: string
          baseOid: string
          headOid: string
          mergeBase: string
        }
        filePath: string
        oldPath?: string
      }
    ): Promise<GitDiffResult> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      const oldPath = args.oldPath
        ? validateGitRelativeFilePath(worktreePath, args.oldPath)
        : undefined
      return getBranchDiff(worktreePath, {
        mergeBase: args.compare.mergeBase,
        headOid: args.compare.headOid,
        filePath,
        oldPath
      })
    }
  )

  ipcMain.handle(
    'git:stage',
    async (_event, args: { worktreePath: string; filePath: string }): Promise<void> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      await stageFile(worktreePath, filePath)
    }
  )

  ipcMain.handle(
    'git:unstage',
    async (_event, args: { worktreePath: string; filePath: string }): Promise<void> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      await unstageFile(worktreePath, filePath)
    }
  )

  ipcMain.handle(
    'git:discard',
    async (_event, args: { worktreePath: string; filePath: string }): Promise<void> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      await discardChanges(worktreePath, filePath)
    }
  )

  ipcMain.handle(
    'git:bulkStage',
    async (_event, args: { worktreePath: string; filePaths: string[] }): Promise<void> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePaths = args.filePaths.map((p) => validateGitRelativeFilePath(worktreePath, p))
      await bulkStageFiles(worktreePath, filePaths)
    }
  )

  ipcMain.handle(
    'git:bulkUnstage',
    async (_event, args: { worktreePath: string; filePaths: string[] }): Promise<void> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePaths = args.filePaths.map((p) => validateGitRelativeFilePath(worktreePath, p))
      await bulkUnstageFiles(worktreePath, filePaths)
    }
  )

  ipcMain.handle(
    'git:remoteFileUrl',
    async (
      _event,
      args: { worktreePath: string; relativePath: string; line: number }
    ): Promise<string | null> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      return getRemoteFileUrl(worktreePath, args.relativePath, args.line)
    }
  )
}
