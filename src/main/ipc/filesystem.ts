/* eslint-disable max-lines */
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readdir, readFile, writeFile, stat, lstat, open, rename, rm } from 'fs/promises'
import { randomUUID } from 'crypto'
import { dirname, extname, join, resolve } from 'path'
import type { ChildProcess } from 'child_process'
import { gitExecFileAsync, wslAwareSpawn } from '../git/runner'
import { parseWslPath, toWindowsWslPath } from '../wsl'
import type { Store } from '../persistence'
import type {
  DirEntry,
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitConflictOperation,
  GitDiffResult,
  GlobalSettings,
  GitPushTarget,
  GitUpstreamStatus,
  GitStatusResult,
  MarkdownDocument,
  SearchOptions,
  SearchResult,
  Repo,
  TuiAgent
} from '../../shared/types'
import type { GitHistoryOptions, GitHistoryResult } from '../../shared/git-history'
import {
  buildRgArgs,
  createAccumulator,
  DEFAULT_SEARCH_MAX_RESULTS,
  finalize,
  ingestRgJsonLine,
  SEARCH_TIMEOUT_MS
} from '../../shared/text-search'
import {
  getStatus,
  abortMerge,
  abortRebase,
  detectConflictOperation,
  getDiff,
  commitChanges,
  stageFile,
  unstageFile,
  bulkStageFiles,
  bulkUnstageFiles,
  bulkDiscardChanges,
  discardChanges,
  getStagedCommitContext,
  getBranchCompare,
  getBranchDiff,
  getCommitCompare,
  getCommitDiff
} from '../git/status'
import { getHistory } from '../git/history'
import {
  cancelGenerateCommitMessageLocal,
  cancelGeneratePullRequestFieldsLocal,
  discoverCommitMessageModelsLocal,
  discoverCommitMessageModelsRemote,
  generateCommitMessageFromContext,
  generatePullRequestFieldsFromContext,
  resolveCommitMessageSettings,
  type DiscoverCommitMessageModelsResult,
  type GenerateCommitMessageResult,
  type GeneratePullRequestFieldsResult
} from '../text-generation/commit-message-text-generation'
import { getPullRequestDraftContext } from '../text-generation/pull-request-context'
import { getUpstreamStatus } from '../git/upstream'
import { gitFastForward, gitFetch, gitPull, gitPullRebaseFromBase, gitPush } from '../git/remote'
import { checkIgnoredPaths } from '../git/check-ignored-paths'
import { assertGitPushTargetShape } from '../../shared/git-push-target-validation'
import { getCommitMessageModelDiscoveryHostKey } from '../../shared/commit-message-host-key'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import { validateGitPushTarget } from '../git/push-target-validation'
import { getRemoteFileUrl } from '../git/repo'
import {
  resolveAuthorizedPath,
  resolveRegisteredWorktreePath,
  validateGitRelativeFilePath,
  isENOENT,
  authorizeExternalPath
} from './filesystem-auth'
import { listQuickOpenFiles } from './filesystem-list-files'
import { registerFilesystemMutationHandlers } from './filesystem-mutations'
import { searchWithGitGrep } from './filesystem-search-git'
import { listMarkdownDocuments, markdownDocumentsFromRelativePaths } from './markdown-documents'
import { checkRgAvailable } from './rg-availability'
import {
  getSshFilesystemProvider,
  requireSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-git-dispatch'
import {
  prepareLocalCommitMessageAgentEnv,
  type CommitMessageAgentEnvironmentResolvers
} from '../text-generation/commit-message-agent-environment'
import { listRepoWorktrees } from '../repo-worktrees'
import { splitWorktreeId } from '../../shared/worktree-id'
import { getRuntimePathBasename } from '../../shared/cross-platform-path'

// Why: Monaco has large-file optimizations like VS Code; blocking at 5MB makes
// ordinary JSON/log files inaccessible before the editor can degrade features.
const MAX_TEXT_FILE_SIZE = 50 * 1024 * 1024 // 50MB
const BINARY_PROBE_BYTES = 8192
const FULL_GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/
// Why: previewable binaries (PDFs, images) are rendered by the viewer as
// base64 blobs, not parsed as text — 5MB is tight for real-world PDFs, and
// raising this cap only affects binary preview, not text/search paths.
// The relay (SSH) uses a smaller 10MB cap because its JSON-RPC frames are
// bounded by MAX_MESSAGE_SIZE = 16MB; the local IPC path has no such limit,
// so 50MB covers real-world PDFs (specs, datasheets, image-heavy contracts).
// See src/relay/fs-handler-utils.ts for the remote-side reasoning.
const MAX_PREVIEWABLE_BINARY_SIZE = 50 * 1024 * 1024 // 50MB
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
const WINDOWS_RESERVED_LOCAL_BASENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const LOCAL_FILENAME_REPLACEMENT_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*'])

type DownloadFileResult = { canceled: true } | { canceled: false; destinationPath: string }

function validateRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`)
  }
  return value
}

function sanitizeSaveDialogFilename(remoteBasename: string): string {
  const sanitized = Array.from(remoteBasename, (char) =>
    char.charCodeAt(0) < 32 || LOCAL_FILENAME_REPLACEMENT_CHARS.has(char) ? '_' : char
  )
    .join('')
    .replace(/[. ]+$/g, '')
  if (!sanitized || WINDOWS_RESERVED_LOCAL_BASENAME.test(sanitized)) {
    return 'download'
  }
  return sanitized
}

function createSiblingTransferPath(destinationPath: string, suffix: string): string {
  return join(dirname(destinationPath), `.${randomUUID()}.${suffix}`)
}

async function cleanupLocalTransferPath(filePath: string | null): Promise<void> {
  if (!filePath) {
    return
  }
  await rm(filePath, { force: true }).catch(() => {})
}

async function inspectDownloadDestination(destinationPath: string): Promise<{ existed: boolean }> {
  try {
    const destinationStat = await stat(destinationPath)
    if (destinationStat.isDirectory()) {
      throw new Error('Cannot download to a directory')
    }
    return { existed: true }
  } catch (error) {
    if (isENOENT(error)) {
      return { existed: false }
    }
    throw error
  }
}

async function assertDestinationStillUnclaimed(destinationPath: string): Promise<void> {
  try {
    await stat(destinationPath)
  } catch (error) {
    if (isENOENT(error)) {
      return
    }
    throw error
  }
  throw new Error('Destination file appeared before download completed')
}

async function promoteDownloadedFile(
  tempPath: string,
  destinationPath: string,
  destinationExisted: boolean
): Promise<void> {
  if (!destinationExisted) {
    await assertDestinationStillUnclaimed(destinationPath)
    await rename(tempPath, destinationPath)
    return
  }

  const backupPath = createSiblingTransferPath(destinationPath, 'backup')
  let backupCreated = false
  try {
    await rename(destinationPath, backupPath)
    backupCreated = true
    await rename(tempPath, destinationPath)
    await cleanupLocalTransferPath(backupPath)
  } catch (error) {
    if (backupCreated) {
      await rename(backupPath, destinationPath).catch(() => {})
    }
    throw error
  }
}

function comparableLocalPath(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function comparableRemotePath(value: string): string {
  return value.replace(/[/\\]+$/g, '')
}

function getCandidateLocalWorktreePaths(
  worktreePath: string,
  resolvedWorktreePath: string
): Set<string> {
  return new Set([worktreePath, resolvedWorktreePath].map(comparableLocalPath))
}

function hasRegisteredWorktreeMetaForRepo(
  store: Store,
  repoId: string,
  candidatePaths: Set<string>
): boolean {
  for (const worktreeId of Object.keys(store.getAllWorktreeMeta())) {
    const parsed = splitWorktreeId(worktreeId)
    if (parsed?.repoId === repoId && candidatePaths.has(comparableLocalPath(parsed.worktreePath))) {
      return true
    }
  }
  return false
}

function hasRegisteredRemoteWorktreeMetaForRepo(
  store: Store,
  repoId: string,
  worktreePath: string
): boolean {
  const comparableWorktreePath = comparableRemotePath(worktreePath)
  for (const worktreeId of Object.keys(store.getAllWorktreeMeta())) {
    const parsed = splitWorktreeId(worktreeId)
    if (
      parsed?.repoId === repoId &&
      comparableRemotePath(parsed.worktreePath) === comparableWorktreePath
    ) {
      return true
    }
  }
  return false
}

async function localRepoOwnsWorktree(
  store: Store,
  repo: Repo,
  worktreePath: string
): Promise<boolean> {
  let resolvedWorktreePath: string
  try {
    resolvedWorktreePath = await resolveRegisteredWorktreePath(worktreePath, store)
  } catch {
    return false
  }
  const candidatePaths = getCandidateLocalWorktreePaths(worktreePath, resolvedWorktreePath)
  if (candidatePaths.has(comparableLocalPath(repo.path))) {
    return true
  }
  if (hasRegisteredWorktreeMetaForRepo(store, repo.id, candidatePaths)) {
    return true
  }
  try {
    const worktrees = await listRepoWorktrees(repo)
    return worktrees.some((worktree) => candidatePaths.has(comparableLocalPath(worktree.path)))
  } catch {
    return false
  }
}

async function remoteRepoOwnsWorktree(
  store: Store,
  repo: Repo,
  worktreePath: string,
  connectionId: string
): Promise<boolean> {
  const comparableWorktreePath = comparableRemotePath(worktreePath)
  if (comparableRemotePath(repo.path) === comparableWorktreePath) {
    return true
  }
  const provider = getSshGitProvider(connectionId)
  if (!provider) {
    return hasRegisteredRemoteWorktreeMetaForRepo(store, repo.id, worktreePath)
  }
  try {
    const worktrees = await provider.listWorktrees(repo.path)
    return worktrees.some(
      (worktree) => comparableRemotePath(worktree.path) === comparableWorktreePath
    )
  } catch {
    return false
  }
}

async function getRepoForSourceControlAi(
  store: Store,
  args: { repoId?: string; worktreePath: string; connectionId?: string }
): Promise<Repo | null> {
  if (!args.repoId) {
    return null
  }
  const repo = store.getRepo(args.repoId)
  if (!repo) {
    return null
  }
  if (args.connectionId) {
    if (repo.connectionId !== args.connectionId) {
      return null
    }
    // Why: a single SSH connection can host several repos; repo-scoped AI
    // overrides only apply when the requested worktree belongs to that repo.
    return (await remoteRepoOwnsWorktree(store, repo, args.worktreePath, args.connectionId))
      ? repo
      : null
  }
  if (repo.connectionId) {
    return null
  }
  // Why: renderer-supplied repoId is advisory; only apply repo overrides when
  // the requested local worktree is known to belong to that repo.
  return (await localRepoOwnsWorktree(store, repo, args.worktreePath)) ? repo : null
}

function validateFullGitObjectId(value: string, label: string): string {
  if (!FULL_GIT_OBJECT_ID_PATTERN.test(value)) {
    throw new Error(`${label} must be a full git object id`)
  }
  return value
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

async function isBinaryFilePrefix(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r')
  try {
    const probe = Buffer.alloc(BINARY_PROBE_BYTES)
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0)
    return isBinaryBuffer(probe.subarray(0, bytesRead))
  } finally {
    await handle.close()
  }
}

async function isDirectoryEntry(
  dirPath: string,
  entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean },
  _resolveEntryPath: (entryPath: string) => Promise<string>
): Promise<boolean> {
  // Why: following a symlink just to decorate readDir can touch macOS
  // TCC-protected app containers. Treat links as file-like until the user
  // explicitly opens them.
  void _resolveEntryPath
  if (entry.isSymbolicLink()) {
    void dirPath
    return false
  }
  if (entry.isDirectory()) {
    return true
  }
  return false
}

export function registerFilesystemHandlers(
  store: Store,
  commitMessageAgentEnv?: CommitMessageAgentEnvironmentResolvers
): void {
  const activeTextSearches = new Map<string, ChildProcess>()

  // ─── Filesystem ─────────────────────────────────────────
  ipcMain.handle(
    'fs:readDir',
    async (_event, args: { dirPath: string; connectionId?: string }): Promise<DirEntry[]> => {
      if (args.connectionId) {
        const provider = requireSshFilesystemProvider(args.connectionId)
        return provider.readDir(args.dirPath)
      }
      const dirPath = await resolveAuthorizedPath(args.dirPath, store)
      const entries = await readdir(dirPath, { withFileTypes: true })
      const mapped = await Promise.all(
        entries.map(async (entry) => ({
          name: entry.name,
          isDirectory: await isDirectoryEntry(dirPath, entry, (entryPath) =>
            resolveAuthorizedPath(entryPath, store)
          ),
          isSymlink: entry.isSymbolicLink()
        }))
      )
      return mapped.sort((a, b) => {
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
        const provider = requireSshFilesystemProvider(args.connectionId)
        return provider.readFile(args.filePath)
      }
      const filePath = await resolveAuthorizedPath(args.filePath, store)
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
          // Why: the renderer/store contract already keys previewable binary
          // rendering off `isImage`. Keep that legacy flag for PDFs too so the
          // new preview path stays compatible with existing callers.
          isImage: true,
          mimeType
        }
      }

      // Why: the text cap is intentionally larger than the old binary cap.
      // Probe unknown large files first so archives do not get fully buffered
      // just to discover they are not editable text.
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
    'fs:downloadFile',
    async (
      event,
      args: { filePath?: string; connectionId?: string }
    ): Promise<DownloadFileResult> => {
      const filePath = validateRequiredString(args?.filePath, 'filePath')
      const connectionId = validateRequiredString(args?.connectionId, 'connectionId')
      const provider = requireSshFilesystemProvider(connectionId)
      const remoteStat = await provider.stat(filePath)
      if (remoteStat.type === 'directory') {
        throw new Error('Cannot download a directory')
      }
      if (!provider.downloadFile) {
        throw new Error('Remote file download is unavailable. Reconnect the SSH target and retry.')
      }

      const remoteBasename = getRuntimePathBasename(filePath)
      const defaultPath = sanitizeSaveDialogFilename(remoteBasename)
      const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const dialogResult = parentWindow
        ? await dialog.showSaveDialog(parentWindow, { defaultPath })
        : await dialog.showSaveDialog({ defaultPath })
      if (dialogResult.canceled || !dialogResult.filePath) {
        return { canceled: true }
      }

      const destinationPath = dialogResult.filePath
      const { existed } = await inspectDownloadDestination(destinationPath)
      const tempPath = createSiblingTransferPath(destinationPath, 'download')
      let promoted = false
      try {
        await provider.downloadFile(filePath, tempPath)
        await promoteDownloadedFile(tempPath, destinationPath, existed)
        promoted = true
        return { canceled: false, destinationPath }
      } finally {
        if (!promoted) {
          await cleanupLocalTransferPath(tempPath)
        }
      }
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
    'fs:writeFile',
    async (
      _event,
      args: { filePath: string; content: string; connectionId?: string }
    ): Promise<void> => {
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
      args: { targetPath: string; connectionId?: string; recursive?: boolean }
    ): Promise<void> => {
      if (args.connectionId) {
        const provider = requireSshFilesystemProvider(args.connectionId)
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
        const provider = requireSshFilesystemProvider(args.connectionId)
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

  // ─── Search ────────────────────────────────────────────
  ipcMain.handle(
    'fs:search',
    async (event, args: SearchOptions & { connectionId?: string }): Promise<SearchResult> => {
      if (args.connectionId) {
        const provider = requireSshFilesystemProvider(args.connectionId)
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
        const rgArgs = buildRgArgs(args.query, rootPath, args)

        // Why: search requests are fired on each query/options change. If the
        // previous ripgrep process keeps running, it can continue streaming and
        // parsing thousands of matches on the Electron main thread after the UI
        // no longer cares about that result, which is exactly the freeze users
        // experience in large repos.
        activeTextSearches.get(searchKey)?.kill()

        const acc = createAccumulator()
        let stdoutBuffer = ''
        let resolved = false
        let child: ChildProcess | null = null
        let killTimeout: ReturnType<typeof setTimeout>

        // Why: when rg runs inside WSL, output paths are Linux-native
        // (e.g. /home/user/repo/src/file.ts). Translate them back to
        // Windows UNC paths so path.relative() and Node fs APIs work.
        const wslInfo = parseWslPath(rootPath)
        const transformAbsPath = wslInfo
          ? (p: string): string => toWindowsWslPath(p, wslInfo.distro)
          : undefined

        const resolveOnce = (): void => {
          if (resolved) {
            return
          }
          resolved = true
          if (activeTextSearches.get(searchKey) === child) {
            activeTextSearches.delete(searchKey)
          }
          clearTimeout(killTimeout)
          // Why: child.kill() is advisory. If rg ignores it, detach our
          // closures so repeated local searches do not retain old scans.
          child?.stdout?.off('data', handleStdoutData)
          child?.stderr?.off('data', handleStderrData)
          child?.off('error', handleError)
          child?.off('close', handleClose)
          resolvePromise(finalize(acc))
        }

        const processLine = (line: string): void => {
          const verdict = ingestRgJsonLine(line, rootPath, acc, maxResults, transformAbsPath)
          if (verdict === 'stop') {
            child?.kill()
          }
        }

        const nextChild = wslAwareSpawn('rg', rgArgs, {
          cwd: rootPath,
          stdio: ['ignore', 'pipe', 'pipe']
        })
        child = nextChild
        activeTextSearches.set(searchKey, nextChild)

        const handleStdoutData = (chunk: string): void => {
          stdoutBuffer += chunk
          const lines = stdoutBuffer.split('\n')
          stdoutBuffer = lines.pop() ?? ''
          for (const line of lines) {
            processLine(line)
          }
        }
        const handleStderrData = (): void => {
          // Drain stderr so rg cannot block on a full pipe.
        }
        const handleError = (): void => {
          resolveOnce()
        }
        const handleClose = (): void => {
          if (stdoutBuffer) {
            processLine(stdoutBuffer)
          }
          resolveOnce()
        }

        nextChild.stdout!.setEncoding('utf-8')
        nextChild.stdout!.on('data', handleStdoutData)
        nextChild.stderr!.on('data', handleStderrData)
        nextChild.once('error', handleError)
        nextChild.once('close', handleClose)

        // Why: if the timeout fires, the child is killed and results are partial.
        // We must mark them as truncated so the UI can indicate incomplete results.
        killTimeout = setTimeout(() => {
          acc.truncated = true
          child?.kill()
          resolveOnce()
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
        // Why: forward excludePaths through to the remote provider.
        // Dropping it here would silently double-scan nested linked worktrees
        // over SSH and contribute to timeout-induced partial results.
        return provider.listFiles(args.rootPath, { excludePaths: args.excludePaths })
      }
      return listQuickOpenFiles(args.rootPath, store, args.excludePaths)
    }
  )

  // ─── Git operations ─────────────────────────────────────
  ipcMain.handle(
    'git:status',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string; includeIgnored?: boolean }
    ): Promise<GitStatusResult> => {
      const options = { includeIgnored: args.includeIgnored ?? false }
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.getStatus(args.worktreePath, options)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      return getStatus(worktreePath, options)
    }
  )

  ipcMain.handle(
    'git:checkIgnored',
    async (
      _event,
      args: { worktreePath: string; paths: string[]; connectionId?: string }
    ): Promise<string[]> => {
      if (args.connectionId) {
        const paths = args.paths.map((p) => validateGitRelativeFilePath(args.worktreePath, p))
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.checkIgnoredPaths(args.worktreePath, paths)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const paths = args.paths.map((p) => validateGitRelativeFilePath(worktreePath, p))
      return checkIgnoredPaths(worktreePath, paths)
    }
  )

  ipcMain.handle(
    'git:history',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string } & GitHistoryOptions
    ): Promise<GitHistoryResult> => {
      const options: GitHistoryOptions = { limit: args.limit, baseRef: args.baseRef }
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.getHistory(args.worktreePath, options)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      return getHistory(worktreePath, options)
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
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.detectConflictOperation(args.worktreePath)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      return detectConflictOperation(worktreePath)
    }
  )

  ipcMain.handle(
    'git:abortMerge',
    async (_event, args: { worktreePath: string; connectionId?: string }): Promise<void> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No git provider for connection "${args.connectionId}"`)
        }
        return provider.abortMerge(args.worktreePath)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      await abortMerge(worktreePath)
    }
  )

  ipcMain.handle(
    'git:abortRebase',
    async (_event, args: { worktreePath: string; connectionId?: string }): Promise<void> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No git provider for connection "${args.connectionId}"`)
        }
        return provider.abortRebase(args.worktreePath)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      await abortRebase(worktreePath)
    }
  )

  ipcMain.handle(
    'git:diff',
    async (
      _event,
      args: {
        worktreePath: string
        filePath: string
        staged: boolean
        compareAgainstHead?: boolean
        connectionId?: string
      }
    ): Promise<GitDiffResult> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.getDiff(
          args.worktreePath,
          args.filePath,
          args.staged,
          args.compareAgainstHead
        )
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      return getDiff(worktreePath, filePath, args.staged, args.compareAgainstHead)
    }
  )

  ipcMain.handle(
    'git:commit',
    async (
      _event,
      args: { worktreePath: string; message: string; connectionId?: string }
    ): Promise<{ success: boolean; error?: string }> => {
      // Why: validate at the IPC boundary so the renderer gets a clear error instead of an opaque execFile failure.
      if (typeof args.message !== 'string' || args.message.trim().length === 0) {
        throw new Error('Commit message is required')
      }
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.commit(args.worktreePath, args.message)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      return commitChanges(worktreePath, args.message)
    }
  )

  ipcMain.handle(
    'git:generateCommitMessage',
    async (
      _event,
      args: {
        worktreePath: string
        repoId?: string
        connectionId?: string
        sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams
        sourceControlAi?: GlobalSettings['sourceControlAi']
        agentCmdOverrides?: GlobalSettings['agentCmdOverrides']
      }
    ): Promise<GenerateCommitMessageResult> => {
      const discoveryHostKey = getCommitMessageModelDiscoveryHostKey(args.connectionId ?? null)
      const baseSettings = store.getSettings()
      const requestSettings = {
        ...baseSettings,
        ...(args.sourceControlAi !== undefined ? { sourceControlAi: args.sourceControlAi } : {}),
        ...(args.agentCmdOverrides !== undefined
          ? { agentCmdOverrides: args.agentCmdOverrides }
          : {})
      }
      const resolvedSettings = args.sourceControlAiResolvedParams
        ? { ok: true as const, params: args.sourceControlAiResolvedParams }
        : resolveCommitMessageSettings(
            requestSettings,
            discoveryHostKey,
            'commitMessage',
            await getRepoForSourceControlAi(store, args)
          )
      if (!resolvedSettings.ok) {
        return { success: false, error: resolvedSettings.error }
      }
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          return {
            success: false,
            error: SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
          }
        }
        let context
        try {
          context = await provider.getStagedCommitContext(args.worktreePath)
        } catch (error) {
          console.error('[filesystem] Failed to read remote staged commit context:', error)
          return {
            success: false,
            error: 'Failed to read staged changes.'
          }
        }
        if (!context) {
          return { success: false, error: 'No staged changes to summarize.' }
        }
        return generateCommitMessageFromContext(context, resolvedSettings.params, {
          kind: 'remote',
          cwd: args.worktreePath,
          execute: (plan, cwd, timeoutMs, operation) =>
            provider.executeCommitMessagePlan(plan, cwd, timeoutMs, operation),
          missingBinaryLocation: 'remote PATH'
        })
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      let context
      try {
        context = await getStagedCommitContext(worktreePath)
      } catch (error) {
        console.error('[filesystem] Failed to read staged commit context:', error)
        return {
          success: false,
          error: 'Failed to read staged changes.'
        }
      }
      if (!context) {
        return { success: false, error: 'No staged changes to summarize.' }
      }
      const localEnv = await prepareLocalCommitMessageAgentEnv(
        resolvedSettings.params.agentId,
        commitMessageAgentEnv
      )
      if (!localEnv.ok) {
        return { success: false, error: localEnv.error }
      }
      return generateCommitMessageFromContext(context, resolvedSettings.params, {
        kind: 'local',
        cwd: worktreePath,
        ...(localEnv.env ? { env: localEnv.env } : {})
      })
    }
  )

  ipcMain.handle(
    'git:cancelGenerateCommitMessage',
    async (_event, args: { worktreePath: string; connectionId?: string }): Promise<void> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          return
        }
        await provider.cancelGenerateCommitMessage(args.worktreePath, 'commit-message')
        return
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      cancelGenerateCommitMessageLocal(worktreePath)
    }
  )

  ipcMain.handle(
    'git:discoverCommitMessageModels',
    async (
      _event,
      args: { agentId: string; worktreePath?: string; connectionId?: string }
    ): Promise<DiscoverCommitMessageModelsResult> => {
      const agentId = args.agentId
      const agentCommandOverride = store.getSettings().agentCmdOverrides?.[agentId as TuiAgent]
      if (args.connectionId) {
        if (!args.worktreePath) {
          return { success: false, error: 'Missing worktree path for remote model discovery.' }
        }
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          return {
            success: false,
            error: `No git provider for connection "${args.connectionId}"`
          }
        }
        return discoverCommitMessageModelsRemote(
          agentId as TuiAgent,
          args.worktreePath,
          (plan, cwd, timeoutMs) => provider.executeCommitMessagePlan(plan, cwd, timeoutMs),
          agentCommandOverride
        )
      }
      const localEnv = await prepareLocalCommitMessageAgentEnv(agentId, commitMessageAgentEnv)
      if (!localEnv.ok) {
        return { success: false, error: localEnv.error }
      }
      return discoverCommitMessageModelsLocal(
        agentId as TuiAgent,
        localEnv.env,
        agentCommandOverride
      )
    }
  )

  ipcMain.handle(
    'git:generatePullRequestFields',
    async (
      _event,
      args: {
        worktreePath: string
        repoId?: string
        base: string
        title: string
        body: string
        draft: boolean
        connectionId?: string
        sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams
        sourceControlAi?: GlobalSettings['sourceControlAi']
        agentCmdOverrides?: GlobalSettings['agentCmdOverrides']
      }
    ): Promise<GeneratePullRequestFieldsResult> => {
      const discoveryHostKey = getCommitMessageModelDiscoveryHostKey(args.connectionId ?? null)
      const baseSettings = store.getSettings()
      const requestSettings = {
        ...baseSettings,
        ...(args.sourceControlAi !== undefined ? { sourceControlAi: args.sourceControlAi } : {}),
        ...(args.agentCmdOverrides !== undefined
          ? { agentCmdOverrides: args.agentCmdOverrides }
          : {})
      }
      const resolvedSettings = args.sourceControlAiResolvedParams
        ? { ok: true as const, params: args.sourceControlAiResolvedParams }
        : resolveCommitMessageSettings(
            requestSettings,
            discoveryHostKey,
            'pullRequest',
            await getRepoForSourceControlAi(store, args)
          )
      if (!resolvedSettings.ok) {
        return { success: false, error: resolvedSettings.error }
      }
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          return {
            success: false,
            error: SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
          }
        }
        let context: Awaited<ReturnType<typeof getPullRequestDraftContext>>
        try {
          context = await getPullRequestDraftContext(
            (argv) => provider.exec(argv, args.worktreePath),
            {
              base: args.base,
              currentTitle: args.title,
              currentBody: args.body,
              currentDraft: args.draft
            }
          )
        } catch (error) {
          return {
            success: false,
            error:
              error instanceof Error ? error.message : 'Failed to prepare branch for PR details.'
          }
        }
        if (!context) {
          return { success: false, error: 'No branch changes to summarize.' }
        }
        return generatePullRequestFieldsFromContext(context, resolvedSettings.params, {
          kind: 'remote',
          cwd: args.worktreePath,
          execute: (plan, cwd, timeoutMs, operation) =>
            provider.executeCommitMessagePlan(plan, cwd, timeoutMs, operation),
          missingBinaryLocation: 'remote PATH'
        })
      }

      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      let context: Awaited<ReturnType<typeof getPullRequestDraftContext>>
      try {
        context = await getPullRequestDraftContext(
          (argv, options) => gitExecFileAsync(argv, { cwd: worktreePath, ...options }),
          {
            base: args.base,
            currentTitle: args.title,
            currentBody: args.body,
            currentDraft: args.draft
          }
        )
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to prepare branch for PR details.'
        }
      }
      if (!context) {
        return { success: false, error: 'No branch changes to summarize.' }
      }
      const localEnv = await prepareLocalCommitMessageAgentEnv(
        resolvedSettings.params.agentId,
        commitMessageAgentEnv
      )
      if (!localEnv.ok) {
        return { success: false, error: localEnv.error }
      }
      return generatePullRequestFieldsFromContext(context, resolvedSettings.params, {
        kind: 'local',
        cwd: worktreePath,
        ...(localEnv.env ? { env: localEnv.env } : {})
      })
    }
  )

  ipcMain.handle(
    'git:cancelGeneratePullRequestFields',
    async (_event, args: { worktreePath: string; connectionId?: string }): Promise<void> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          return
        }
        await provider.cancelGenerateCommitMessage(args.worktreePath, 'pull-request-fields')
        return
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      cancelGeneratePullRequestFieldsLocal(worktreePath)
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
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.getBranchCompare(args.worktreePath, args.baseRef)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      return getBranchCompare(worktreePath, args.baseRef)
    }
  )

  ipcMain.handle(
    'git:commitCompare',
    async (
      _event,
      args: { worktreePath: string; commitId: string; connectionId?: string }
    ): Promise<GitCommitCompareResult> => {
      const commitId = validateFullGitObjectId(args.commitId, 'commitId')
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.getCommitCompare(args.worktreePath, commitId)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      return getCommitCompare(worktreePath, commitId)
    }
  )

  ipcMain.handle(
    'git:upstreamStatus',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string; pushTarget?: GitPushTarget }
    ): Promise<GitUpstreamStatus> => {
      if (args.connectionId) {
        if (args.pushTarget) {
          assertGitPushTargetShape(args.pushTarget)
        }
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.getUpstreamStatus(args.worktreePath, args.pushTarget)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      return getUpstreamStatus(worktreePath, args.pushTarget)
    }
  )

  ipcMain.handle(
    'git:fetch',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string; pushTarget?: GitPushTarget }
    ): Promise<void> => {
      if (args.connectionId) {
        if (args.pushTarget) {
          assertGitPushTargetShape(args.pushTarget)
        }
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.fetchRemote(args.worktreePath, args.pushTarget)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      if (args.pushTarget) {
        await validateGitPushTarget(worktreePath, args.pushTarget)
      }
      await gitFetch(worktreePath, args.pushTarget)
    }
  )

  ipcMain.handle(
    'git:push',
    async (
      _event,
      args: {
        worktreePath: string
        publish?: boolean
        forceWithLease?: boolean
        connectionId?: string
        pushTarget?: GitPushTarget
      }
    ): Promise<void> => {
      // Why: coerce to strict boolean at the IPC boundary so a malformed
      // renderer payload (e.g. string 'false') can't silently enable
      // --set-upstream mode. Mirrors the relay handler in src/relay/git-handler.ts.
      const publish = args.publish === true
      if (args.connectionId) {
        if (args.pushTarget) {
          assertGitPushTargetShape(args.pushTarget)
        }
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.pushBranch(args.worktreePath, publish, args.pushTarget, {
          forceWithLease: args.forceWithLease === true
        })
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      if (args.pushTarget) {
        await validateGitPushTarget(worktreePath, args.pushTarget)
      }
      await gitPush(worktreePath, publish, args.pushTarget, {
        forceWithLease: args.forceWithLease === true
      })
    }
  )

  ipcMain.handle(
    'git:pull',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string; pushTarget?: GitPushTarget }
    ): Promise<void> => {
      if (args.connectionId) {
        if (args.pushTarget) {
          assertGitPushTargetShape(args.pushTarget)
        }
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.pullBranch(args.worktreePath, args.pushTarget)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      if (args.pushTarget) {
        await validateGitPushTarget(worktreePath, args.pushTarget)
      }
      await gitPull(worktreePath, args.pushTarget)
    }
  )

  ipcMain.handle(
    'git:fastForward',
    async (
      _event,
      args: { worktreePath: string; connectionId?: string; pushTarget?: GitPushTarget }
    ): Promise<void> => {
      if (args.connectionId) {
        if (args.pushTarget) {
          assertGitPushTargetShape(args.pushTarget)
        }
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.fastForwardBranch(args.worktreePath, args.pushTarget)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      if (args.pushTarget) {
        await validateGitPushTarget(worktreePath, args.pushTarget)
      }
      await gitFastForward(worktreePath, args.pushTarget)
    }
  )

  ipcMain.handle(
    'git:rebaseFromBase',
    async (
      _event,
      args: { worktreePath: string; baseRef: string; connectionId?: string }
    ): Promise<void> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.rebaseFromBase(args.worktreePath, args.baseRef)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      await gitPullRebaseFromBase(worktreePath, args.baseRef)
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
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
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
    'git:commitDiff',
    async (
      _event,
      args: {
        worktreePath: string
        commitOid: string
        parentOid?: string | null
        filePath: string
        oldPath?: string
        connectionId?: string
      }
    ): Promise<GitDiffResult> => {
      const commitOid = validateFullGitObjectId(args.commitOid, 'commitOid')
      const parentOid = args.parentOid ? validateFullGitObjectId(args.parentOid, 'parentOid') : null
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.getCommitDiff(args.worktreePath, {
          commitOid,
          parentOid,
          filePath: args.filePath,
          oldPath: args.oldPath
        })
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      const oldPath = args.oldPath
        ? validateGitRelativeFilePath(worktreePath, args.oldPath)
        : undefined
      return getCommitDiff(worktreePath, {
        commitOid,
        parentOid,
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
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
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
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
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
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.discardChanges(args.worktreePath, args.filePath)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePath = validateGitRelativeFilePath(worktreePath, args.filePath)
      await discardChanges(worktreePath, filePath)
    }
  )

  ipcMain.handle(
    'git:bulkDiscard',
    async (
      _event,
      args: { worktreePath: string; filePaths: string[]; connectionId?: string }
    ): Promise<void> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.bulkDiscardChanges(args.worktreePath, args.filePaths)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const filePaths = args.filePaths.map((p) => validateGitRelativeFilePath(worktreePath, p))
      await bulkDiscardChanges(worktreePath, filePaths)
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
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
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
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
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
      // Why: remote repos can't read relay-side .git/config locally. Delegate
      // URL construction to the SSH provider, which can fetch remote metadata.
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.getRemoteFileUrl(args.worktreePath, args.relativePath, args.line)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      return getRemoteFileUrl(worktreePath, args.relativePath, args.line)
    }
  )
}
