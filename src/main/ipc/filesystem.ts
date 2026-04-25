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
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
// Why: previewable binaries (PDFs, images) are rendered by the viewer as
// base64 blobs, not parsed as text — 5MB is tight for real-world PDFs, and
// raising this cap only affects binary preview, not text/search paths.
// The relay (SSH) uses a smaller 10MB cap because its JSON-RPC frames are
// bounded by MAX_MESSAGE_SIZE = 16MB; the local IPC path has no such limit,
// so 50MB covers real-world PDFs (specs, datasheets, image-heavy contracts).
// See src/relay/fs-handler-utils.ts for the remote-side reasoning.
const MAX_PREVIEWABLE_BINARY_SIZE = 50 * 1024 * 1024 // 50MB
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
  ipcMain.handle(
    'fs:readDir',
    async (_event, args: { dirPath: string; connectionId?: string }): Promise<DirEntry[]> => {
      if (args.connectionId) {
        const provider = getSshFilesystemProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No filesystem provider for connection "${args.connectionId}"`)
        }
        return provider.readDir(args.dirPath)
      }
      const dirPath = await resolveAuthorizedPath(args.dirPath, store)
      const entries = await readdir(dirPath, { withFileTypes: true })
      return entries
        .map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          isSymlink: entry.isSymbolicLink()
        }))
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) {
            return a.isDirectory ? -1 : 1
          }
          return a.name.localeCompare(b.name)
        })
    }
  )

  ipcMain.handle(
    'fs:readFile',
    async (
      _event,
      args: { filePath: string; connectionId?: string }
    ): Promise<{ content: string; isBinary: boolean; isImage?: boolean; mimeType?: string }> => {
      if (args.connectionId) {
        const provider = getSshFilesystemProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No filesystem provider for connection "${args.connectionId}"`)
        }
        return provider.readFile(args.filePath)
      }
      const filePath = await resolveAuthorizedPath(args.filePath, store)
      const stats = await stat(filePath)
      const mimeType = PREVIEWABLE_BINARY_MIME_TYPES[extname(filePath).toLowerCase()]
      const sizeLimit = mimeType ? MAX_PREVIEWABLE_BINARY_SIZE : MAX_FILE_SIZE
      if (stats.size > sizeLimit) {
        throw new Error(
          `File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds ${sizeLimit / 1024 / 1024}MB limit`
        )
      }

      const buffer = await readFile(filePath)
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
    async (
      _event,
      args: { filePath: string; content: string; connectionId?: string }
    ): Promise<void> => {
      if (args.connectionId) {
        const provider = getSshFilesystemProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No filesystem provider for connection "${args.connectionId}"`)
        }
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
      args: { targetPath: string; connectionId?: string; recursive?: boolean }
    ): Promise<void> => {
      if (args.connectionId) {
        const provider = getSshFilesystemProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No filesystem provider for connection "${args.connectionId}"`)
        }
        return provider.deletePath(args.targetPath, args.recursive)
      }
      // Why: deleting must operate on the symlink itself, not its target.
      // Following the link with realpath() would trash the real file — which
      // could be another file inside the worktree, or a path outside all
      // allowed roots that we would never be able to delete again.
      const targetPath = await resolveAuthorizedPath(args.targetPath, store, {
        preserveSymlink: true
      })

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
    }
  )

  registerFilesystemMutationHandlers(store)

  ipcMain.handle('fs:authorizeExternalPath', (_event, args: { targetPath: string }): void => {
    authorizeExternalPath(args.targetPath)
  })

  ipcMain.handle(
    'fs:stat',
    async (
      _event,
      args: { filePath: string; connectionId?: string }
    ): Promise<{ size: number; isDirectory: boolean; mtime: number }> => {
      if (args.connectionId) {
        const provider = getSshFilesystemProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No filesystem provider for connection "${args.connectionId}"`)
        }
        const s = await provider.stat(args.filePath)
        return { size: s.size, isDirectory: s.type === 'directory', mtime: s.mtime }
      }
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
  ipcMain.handle(
    'fs:search',
    async (event, args: SearchOptions & { connectionId?: string }): Promise<SearchResult> => {
      if (args.connectionId) {
        const provider = getSshFilesystemProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No filesystem provider for connection "${args.connectionId}"`)
        }
        return provider.search(args)
      }
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
    }
  )

  // ─── List all files (for quick-open) ─────────────────────
  ipcMain.handle(
    'fs:listFiles',
    async (
      _event,
      args: { rootPath: string; connectionId?: string; excludePaths?: string[] }
    ): Promise<string[]> => {
      if (args.connectionId) {
        const provider = getSshFilesystemProvider(args.connectionId)
        // Why: when the SSH connection is not yet established (cold start) or
        // temporarily disconnected, return [] so quick-open shows "No matching
        // files" instead of an error banner. The file list will repopulate when
        // the user re-opens quick-open after the connection is restored.
        if (!provider) {
          return []
        }
        return provider.listFiles(args.rootPath)
      }
      return listQuickOpenFiles(args.rootPath, store, args.excludePaths)
    }
  )

  // ─── Git operations ─────────────────────────────────────
  ipcMain.handle(
    'git:status',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string }
    ): Promise<GitStatusResult> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No git provider for connection "${args.connectionId}"`)
        }
        return provider.getStatus(args.worktreePath)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      return getStatus(worktreePath)
    }
  )

  // Why: lightweight fs-only check for conflict operation state. Used to poll
  // non-active worktrees so their "Rebasing"/"Merging" badges clear when the
  // operation finishes, without running a full `git status`.
  ipcMain.handle(
    'git:conflictOperation',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string }
    ): Promise<GitConflictOperation> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No git provider for connection "${args.connectionId}"`)
        }
        return provider.detectConflictOperation(args.worktreePath)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      return detectConflictOperation(worktreePath)
    }
  )

  ipcMain.handle(
    'git:diff',
    async (
      _event,
      args: { worktreePath: string; filePath: string; staged: boolean; connectionId?: string }
    ): Promise<GitDiffResult> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No git provider for connection "${args.connectionId}"`)
        }
        return provider.getDiff(args.worktreePath, args.filePath, args.staged)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      return getDiff(worktreePath, filePath, args.staged)
    }
  )

  ipcMain.handle(
    'git:branchCompare',
    async (
      _event,
      args: { worktreePath: string; baseRef: string; connectionId?: string }
    ): Promise<GitBranchCompareResult> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No git provider for connection "${args.connectionId}"`)
        }
        return provider.getBranchCompare(args.worktreePath, args.baseRef)
      }
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
        connectionId?: string
      }
    ): Promise<GitDiffResult> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No git provider for connection "${args.connectionId}"`)
        }
        const results = await provider.getBranchDiff(args.worktreePath, args.compare.mergeBase, {
          includePatch: true,
          filePath: args.filePath,
          oldPath: args.oldPath
        })
        return (
          results[0] ?? {
            kind: 'text',
            originalContent: '',
            modifiedContent: '',
            originalIsBinary: false,
            modifiedIsBinary: false
          }
        )
      }
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
    async (
      _event,
      args: { worktreePath: string; filePath: string; connectionId?: string }
    ): Promise<void> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No git provider for connection "${args.connectionId}"`)
        }
        return provider.stageFile(args.worktreePath, args.filePath)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      await stageFile(worktreePath, filePath)
    }
  )

  ipcMain.handle(
    'git:unstage',
    async (
      _event,
      args: { worktreePath: string; filePath: string; connectionId?: string }
    ): Promise<void> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No git provider for connection "${args.connectionId}"`)
        }
        return provider.unstageFile(args.worktreePath, args.filePath)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      await unstageFile(worktreePath, filePath)
    }
  )

  ipcMain.handle(
    'git:discard',
    async (
      _event,
      args: { worktreePath: string; filePath: string; connectionId?: string }
    ): Promise<void> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No git provider for connection "${args.connectionId}"`)
        }
        return provider.discardChanges(args.worktreePath, args.filePath)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      await discardChanges(worktreePath, filePath)
    }
  )

  ipcMain.handle(
    'git:bulkStage',
    async (
      _event,
      args: { worktreePath: string; filePaths: string[]; connectionId?: string }
    ): Promise<void> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No git provider for connection "${args.connectionId}"`)
        }
        return provider.bulkStageFiles(args.worktreePath, args.filePaths)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePaths = args.filePaths.map((p) => validateGitRelativeFilePath(worktreePath, p))
      await bulkStageFiles(worktreePath, filePaths)
    }
  )

  ipcMain.handle(
    'git:bulkUnstage',
    async (
      _event,
      args: { worktreePath: string; filePaths: string[]; connectionId?: string }
    ): Promise<void> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No git provider for connection "${args.connectionId}"`)
        }
        return provider.bulkUnstageFiles(args.worktreePath, args.filePaths)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePaths = args.filePaths.map((p) => validateGitRelativeFilePath(worktreePath, p))
      await bulkUnstageFiles(worktreePath, filePaths)
    }
  )

  ipcMain.handle(
    'git:remoteFileUrl',
    async (
      _event,
      args: { worktreePath: string; relativePath: string; line: number; connectionId?: string }
    ): Promise<string | null> => {
      // Why: remote repos can't use the local hosted-git-info approach because
      // the .git/config lives on the remote. Route through the relay's git.exec
      // to fetch the remote URL and build the file link server-side.
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No git provider for connection "${args.connectionId}"`)
        }
        return provider.getRemoteFileUrl(args.worktreePath, args.relativePath, args.line)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      return getRemoteFileUrl(worktreePath, args.relativePath, args.line)
    }
  )
}
