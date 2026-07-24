/* eslint-disable max-lines */
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { readdir, readFile, writeFile, stat, lstat, open, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, extname, join, resolve } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { gitExecFileAsync, wslAwareSpawn } from '../git/runner'
import { parseWslPath, toWindowsWslPath } from '../wsl'
import { tryDeleteWslUncPath } from '../wsl-unc-delete'
import type { Store } from '../persistence'
import type {
  DirEntry,
  GitBranchCompareResult,
  GitCommitCompareResult,
  GitConflictOperation,
  GitDiffResult,
  GitForkSyncExpectedUpstream,
  GitForkSyncResult,
  GlobalSettings,
  GitStagingArea,
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
import type { SshMutationExpectation } from '../../shared/ssh-types'
import { assertSshMutationExpectation } from '../ssh/ssh-connection-generation'
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
  getSubmoduleStatus,
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
  type CommitMessageGenerationTarget,
  type GenerateCommitMessageResult,
  type GeneratePullRequestFieldsResult
} from '../text-generation/commit-message-text-generation'
import { getPullRequestDraftContext } from '../text-generation/pull-request-context'
import { getUpstreamStatus } from '../git/upstream'
import { gitFastForward, gitFetch, gitPull, gitPullRebaseFromBase, gitPush } from '../git/remote'
import { gitSyncForkDefaultBranch } from '../git/fork-sync'
import { validateGitForkSyncExpectedUpstream } from '../../shared/git-fork-sync'
import { checkIgnoredPaths } from '../git/check-ignored-paths'
import {
  appendFolderToGitignore,
  findKnownHugeFolderPathsToIgnore
} from '../git/huge-folder-ignore'
import { assertGitPushTargetShape } from '../../shared/git-push-target-validation'
import { getCommitMessageModelDiscoveryHostKey } from '../../shared/commit-message-host-key'
import type { HostedReviewProvider } from '../../shared/hosted-review'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import { validateGitPushTarget } from '../git/push-target-validation'
import { getRemoteCommitUrl, getRemoteFileUrl } from '../git/repo'
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
import { getLocalGitOptionsForRegisteredWorktree } from './local-worktree-runtime-options'
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
import { resolveHostedReviewBodyForGeneration } from '../source-control/pull-request-template'
import {
  prepareLocalCommitMessageAgentEnv,
  type CommitMessageAgentRuntimeTarget,
  type CommitMessageAgentEnvironmentResolvers
} from '../text-generation/commit-message-agent-environment'
import { listRepoWorktrees } from '../repo-worktrees'
import { recordCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'
import { buildReadDirErrorBreadcrumb, type ReadDirThrowSite } from './readdir-error-diagnostics'
import { splitWorktreeId } from '../../shared/worktree-id'
import { getRuntimePathBasename } from '../../shared/cross-platform-path'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { registerLocalLogTailHandlers } from './local-log-tail'
import { localLogFileIdentity } from '../ai-vault/local-log-tail-reader'
import { sanitizeLocalDownloadFilename } from '../local-download-filename'
import { registerFilesystemDownloadFolderHandlers } from './filesystem-download-folder'
import { createSenderScopedRequestCancellations } from './sender-scoped-request-cancellation'

// Why: Monaco degrades features on large files like VS Code, so a 5MB block would needlessly lock out ordinary JSON/log files.
const MAX_TEXT_FILE_SIZE = 50 * 1024 * 1024 // 50MB
const BINARY_PROBE_BYTES = 8192
const FULL_GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/
// Why: previewable binaries are base64 blobs (not parsed as text), and local IPC has no frame limit (unlike the relay's 10MB), so 50MB is safe.
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
async function readLocalLogSnapshot(filePath: string): Promise<{
  content: string
  isBinary: boolean
  fileIdentity?: string
}> {
  const handle = await open(filePath, 'r')
  try {
    const stats = await handle.stat()
    if (stats.size > MAX_TEXT_FILE_SIZE) {
      throw new Error(
        `File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_TEXT_FILE_SIZE / 1024 / 1024}MB limit`
      )
    }
    const buffer = await handle.readFile()
    if (buffer.byteLength > MAX_TEXT_FILE_SIZE) {
      throw new Error(
        `File too large: ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB exceeds ${MAX_TEXT_FILE_SIZE / 1024 / 1024}MB limit`
      )
    }
    if (isBinaryBuffer(buffer)) {
      return { content: '', isBinary: true }
    }
    return {
      content: buffer.toString('utf8'),
      isBinary: false,
      fileIdentity: localLogFileIdentity(stats)
    }
  } finally {
    await handle.close()
  }
}

type DownloadFileResult = { canceled: true } | { canceled: false; destinationPath: string }

function validateRequiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`)
  }
  return value
}

function decodeDownloadedFileContent(content: string, encoding: 'utf8' | 'base64'): Buffer {
  if (encoding === 'base64') {
    return Buffer.from(content, 'base64')
  }
  return Buffer.from(content, 'utf8')
}

type DownloadSession = {
  destinationPath: string
  tempPath: string
  destinationExisted: boolean
  handle: FileHandle
  cleanupTimer: ReturnType<typeof setTimeout>
  senderId: number
}

const DOWNLOAD_SESSION_TTL_MS = 30 * 60 * 1000

function createSiblingTransferPath(destinationPath: string, suffix: string): string {
  // Why: promotion renames must stay on the destination volume, so transfer paths remain siblings.
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

function comparableRemotePath(value: string): string {
  return value.replace(/[/\\]+$/g, '')
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
    // Why: one SSH connection can host several repos; repo-scoped AI overrides apply only when the worktree belongs to that repo.
    return (await remoteRepoOwnsWorktree(store, repo, args.worktreePath, args.connectionId))
      ? repo
      : null
  }
  if (repo.connectionId) {
    return null
  }
  // Why: renderer-supplied repoId is advisory; apply repo overrides only when the local worktree belongs to that repo.
  return (await localRepoOwnsWorktree(store, repo, args.worktreePath)) ? repo : null
}

function getLocalAgentRuntimeTarget(
  gitOptions: LocalProjectWorktreeGitOptions
): CommitMessageAgentRuntimeTarget {
  return gitOptions.wslDistro
    ? { runtime: 'wsl', wslDistro: gitOptions.wslDistro }
    : { runtime: 'host' }
}

function getLocalTextGenerationTarget(
  worktreePath: string,
  gitOptions: LocalProjectWorktreeGitOptions,
  env?: NodeJS.ProcessEnv
): Extract<CommitMessageGenerationTarget, { kind: 'local' }> {
  return {
    kind: 'local',
    cwd: worktreePath,
    ...(gitOptions.wslDistro ? { wslDistro: gitOptions.wslDistro } : {}),
    ...(env ? { env } : {})
  }
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
  // Why: following a symlink in readDir can touch macOS TCC-protected containers; treat links as file-like until explicitly opened.
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
  const downloadSessions = new Map<string, DownloadSession>()

  async function closeDownloadSession(
    transferId: string,
    cleanupTemp: boolean
  ): Promise<DownloadSession | null> {
    const session = downloadSessions.get(transferId)
    if (!session) {
      return null
    }
    downloadSessions.delete(transferId)
    clearTimeout(session.cleanupTimer)
    await session.handle.close().catch(() => {})
    if (cleanupTemp) {
      await cleanupLocalTransferPath(session.tempPath)
    }
    return session
  }

  function cleanupDownloadSessionsForSender(senderId: number): void {
    for (const [transferId, session] of Array.from(downloadSessions)) {
      if (session.senderId === senderId) {
        void closeDownloadSession(transferId, true)
      }
    }
  }

  // ─── Filesystem ─────────────────────────────────────────
  ipcMain.handle(
    'fs:readDir',
    async (_event, args: { dirPath: string; connectionId?: string }): Promise<DirEntry[]> => {
      // Why: fs:readDir throws surface as opaque IPC errors; record the throw site + redacted path shape to keep them diagnosable.
      let throwSite: ReadDirThrowSite = 'authorize'
      try {
        if (args.connectionId) {
          throwSite = 'ssh-provider'
          const provider = requireSshFilesystemProvider(args.connectionId)
          return await provider.readDir(args.dirPath)
        }
        throwSite = 'authorize'
        const dirPath = await resolveAuthorizedPath(args.dirPath, store)
        throwSite = 'readdir'
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
      const defaultPath = sanitizeLocalDownloadFilename(remoteBasename)
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

  registerFilesystemDownloadFolderHandlers()

  ipcMain.handle(
    'fs:saveDownloadedFile',
    async (
      event,
      args: { suggestedName?: string; content?: string; encoding?: 'utf8' | 'base64' }
    ): Promise<DownloadFileResult> => {
      const suggestedName = sanitizeLocalDownloadFilename(
        validateRequiredString(args?.suggestedName, 'suggestedName')
      )
      if (typeof args?.content !== 'string') {
        throw new Error('content is required')
      }
      const content = args.content
      const encoding = args?.encoding === 'base64' ? 'base64' : 'utf8'
      const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const dialogResult = parentWindow
        ? await dialog.showSaveDialog(parentWindow, { defaultPath: suggestedName })
        : await dialog.showSaveDialog({ defaultPath: suggestedName })
      if (dialogResult.canceled || !dialogResult.filePath) {
        return { canceled: true }
      }

      const destinationPath = dialogResult.filePath
      const { existed } = await inspectDownloadDestination(destinationPath)
      const tempPath = createSiblingTransferPath(destinationPath, 'download')
      let promoted = false
      try {
        await writeFile(tempPath, decodeDownloadedFileContent(content, encoding))
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
    'fs:startDownloadedFile',
    async (
      event,
      args: { suggestedName?: string }
    ): Promise<
      | { canceled: true }
      | {
          canceled: false
          transferId: string
          destinationPath: string
        }
    > => {
      const suggestedName = sanitizeLocalDownloadFilename(
        validateRequiredString(args?.suggestedName, 'suggestedName')
      )
      const parentWindow = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const dialogResult = parentWindow
        ? await dialog.showSaveDialog(parentWindow, { defaultPath: suggestedName })
        : await dialog.showSaveDialog({ defaultPath: suggestedName })
      if (dialogResult.canceled || !dialogResult.filePath) {
        return { canceled: true }
      }

      const destinationPath = dialogResult.filePath
      const { existed } = await inspectDownloadDestination(destinationPath)
      const tempPath = createSiblingTransferPath(destinationPath, 'download')
      const transferId = randomUUID()
      try {
        const handle = await open(tempPath, 'wx')
        const senderId = typeof event.sender.id === 'number' ? event.sender.id : Number.NaN
        const cleanupTimer = setTimeout(() => {
          void closeDownloadSession(transferId, true)
        }, DOWNLOAD_SESSION_TTL_MS)
        if (typeof cleanupTimer.unref === 'function') {
          cleanupTimer.unref()
        }
        downloadSessions.set(transferId, {
          destinationPath,
          tempPath,
          destinationExisted: existed,
          handle,
          cleanupTimer,
          senderId
        })
        event.sender.once?.('destroyed', () => cleanupDownloadSessionsForSender(senderId))
        return { canceled: false, transferId, destinationPath }
      } catch (error) {
        await cleanupLocalTransferPath(tempPath)
        throw error
      }
    }
  )

  ipcMain.handle(
    'fs:appendDownloadedFileChunk',
    async (
      _event,
      args: { transferId?: string; contentBase64?: string }
    ): Promise<{ ok: true }> => {
      const transferId = validateRequiredString(args?.transferId, 'transferId')
      const contentBase64 = validateRequiredString(args?.contentBase64, 'contentBase64')
      const session = downloadSessions.get(transferId)
      if (!session) {
        throw new Error('Download session not found')
      }
      await session.handle.writeFile(Buffer.from(contentBase64, 'base64'))
      return { ok: true }
    }
  )

  ipcMain.handle(
    'fs:finishDownloadedFile',
    async (
      _event,
      args: { transferId?: string }
    ): Promise<{ canceled: false; destinationPath: string }> => {
      const transferId = validateRequiredString(args?.transferId, 'transferId')
      const session = await closeDownloadSession(transferId, false)
      if (!session) {
        throw new Error('Download session not found')
      }
      let promoted = false
      try {
        await promoteDownloadedFile(
          session.tempPath,
          session.destinationPath,
          session.destinationExisted
        )
        promoted = true
        return { canceled: false, destinationPath: session.destinationPath }
      } finally {
        if (!promoted) {
          await cleanupLocalTransferPath(session.tempPath)
        }
      }
    }
  )

  ipcMain.handle(
    'fs:cancelDownloadedFile',
    async (_event, args: { transferId?: string }): Promise<{ ok: true }> => {
      const transferId = validateRequiredString(args?.transferId, 'transferId')
      await closeDownloadSession(transferId, true)
      return { ok: true }
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
      const localGitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.rootPath,
        rootPath
      )
      const maxResults = Math.max(
        1,
        Math.min(args.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS, DEFAULT_SEARCH_MAX_RESULTS)
      )
      const searchKey = `${event.sender.id}:${rootPath}`

      // Why: probe rg upfront; on some platforms spawn emits 'close' before 'error', resolving empty before the git-grep fallback runs.
      const rgAvailable = await checkRgAvailable(rootPath, localGitOptions.wslDistro)
      if (!rgAvailable) {
        return searchWithGitGrep(rootPath, args, maxResults, localGitOptions)
      }

      return new Promise((resolvePromise) => {
        const rgArgs = buildRgArgs(args.query, rootPath, args)

        // Why: kill the prior rg so it stops parsing thousands of matches on the main thread (the large-repo freeze) after the UI moved on.
        activeTextSearches.get(searchKey)?.kill()

        const acc = createAccumulator()
        let stdoutBuffer = ''
        let resolved = false
        let child: ChildProcess | null = null
        let killTimeout: ReturnType<typeof setTimeout>

        // Why: WSL-routed rg emits Linux paths; UNC repos carry the distro in the path, Windows-path repos in project runtime.
        const wslDistroForOutput = parseWslPath(rootPath)?.distro ?? localGitOptions.wslDistro
        const transformAbsPath = wslDistroForOutput
          ? (p: string): string => (p.startsWith('/') ? toWindowsWslPath(p, wslDistroForOutput) : p)
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
          // Why: child.kill() is advisory; detach our closures so repeated searches don't retain old scans if rg ignores it.
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
          ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
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

        // Why: timeout kills the child mid-scan; mark truncated so the UI shows incomplete results.
        killTimeout = setTimeout(() => {
          acc.truncated = true
          child?.kill()
          resolveOnce()
        }, SEARCH_TIMEOUT_MS)
      })
    }
  )

  // ─── List all files (for quick-open) ─────────────────────
  // Why #7721: token-keyed so a workspace switch aborts the prior full-tree scan (SSH otherwise stacks scans past the 30s timeout).
  const listFilesCancellations = createSenderScopedRequestCancellations()
  ipcMain.handle(
    'fs:listFiles',
    async (
      event,
      args: {
        rootPath: string
        connectionId?: string
        excludePaths?: string[]
        requestToken?: string
      }
    ): Promise<string[]> => {
      const controller = listFilesCancellations.begin(event, args.requestToken)
      try {
        if (args.connectionId) {
          const provider = getSshFilesystemProvider(args.connectionId)
          // Why: no provider (cold start / disconnected) → return [] so quick-open shows "No matching files" instead of an error.
          if (!provider) {
            return []
          }
          // Why: forward excludePaths or nested linked worktrees get double-scanned over SSH, causing timeout-induced partial results.
          return await provider.listFiles(args.rootPath, {
            excludePaths: args.excludePaths,
            signal: controller?.signal
          })
        }
        return await listQuickOpenFiles(args.rootPath, store, args.excludePaths, controller?.signal)
      } finally {
        listFilesCancellations.finish(event, args.requestToken, controller)
      }
    }
  )

  ipcMain.handle('fs:cancelListFiles', (event, args: { requestToken: string }): void => {
    listFilesCancellations.cancel(event, args.requestToken)
  })

  // ─── Git operations ─────────────────────────────────────
  const gitStatusCancellations = createSenderScopedRequestCancellations()
  ipcMain.handle(
    'git:status',
    async (
      event,
      args: {
        worktreePath: string
        connectionId?: string
        includeIgnored?: boolean
        bypassEffectiveUpstreamNegativeCache?: boolean
        reuseLineStats?: boolean
        requestToken?: string
      }
    ): Promise<GitStatusResult> => {
      const controller = gitStatusCancellations.begin(event, args.requestToken)
      const options = {
        includeIgnored: args.includeIgnored ?? false,
        ...(args.reuseLineStats === true ? { reuseLineStats: true } : {}),
        ...(args.bypassEffectiveUpstreamNegativeCache === true
          ? { bypassEffectiveUpstreamNegativeCache: true }
          : {}),
        ...(controller ? { signal: controller.signal } : {})
      }
      try {
        if (args.connectionId) {
          const provider = getSshGitProvider(args.connectionId)
          if (!provider) {
            throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
          }
          // Why: await keeps the cancellation token registered until the remote request settles (an early finally would free it).
          return await provider.getStatus(args.worktreePath, options)
        }
        const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
        const gitOptions = getLocalGitOptionsForRegisteredWorktree(
          store,
          args.worktreePath,
          worktreePath
        )
        return await getStatus(worktreePath, { ...options, ...gitOptions })
      } finally {
        gitStatusCancellations.finish(event, args.requestToken, controller)
      }
    }
  )

  ipcMain.handle('git:cancelStatus', (event, args: { requestToken: string }): void => {
    gitStatusCancellations.cancel(event, args.requestToken)
  })

  // Why: parent status reports only one gitlink row per submodule; fetch inner per-file changes from the submodule's own worktree.
  ipcMain.handle(
    'git:submoduleStatus',
    async (
      _event,
      args: {
        worktreePath: string
        submodulePath: string
        connectionId?: string
        area?: GitStagingArea
      }
    ): Promise<GitStatusResult> => {
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.getSubmoduleStatus(args.worktreePath, args.submodulePath, args.area)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return getSubmoduleStatus(worktreePath, args.submodulePath, {
        ...gitOptions,
        ...(args.area === 'staged' ? { staged: true } : {})
      })
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return checkIgnoredPaths(worktreePath, paths, gitOptions)
    }
  )

  // Why: backs the SCM "ignore the flooding folder" flow; local-only since huge untracked folders are a local-dev pathology.
  ipcMain.handle(
    'git:findHugeFoldersToIgnore',
    async (_event, args: { worktreePath: string }): Promise<string[]> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return findKnownHugeFolderPathsToIgnore(worktreePath, gitOptions)
    }
  )

  ipcMain.handle(
    'git:appendGitignore',
    async (_event, args: { worktreePath: string; folderName: string }): Promise<boolean> => {
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      return appendFolderToGitignore(worktreePath, args.folderName)
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return getHistory(worktreePath, { ...options, ...gitOptions })
    }
  )

  // Why: fs-only conflict-state check so non-active worktrees can clear their Rebasing/Merging badges without a full git status.
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await abortMerge(worktreePath, gitOptions)
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await abortRebase(worktreePath, gitOptions)
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return getDiff(worktreePath, filePath, args.staged, args.compareAgainstHead, gitOptions)
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return commitChanges(worktreePath, args.message, gitOptions)
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      let context
      try {
        context = await getStagedCommitContext(worktreePath, gitOptions)
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
        commitMessageAgentEnv,
        getLocalAgentRuntimeTarget(gitOptions)
      )
      if (!localEnv.ok) {
        return { success: false, error: localEnv.error }
      }
      return generateCommitMessageFromContext(
        context,
        resolvedSettings.params,
        getLocalTextGenerationTarget(worktreePath, gitOptions, localEnv.env)
      )
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
      let localRuntimeTarget: CommitMessageAgentRuntimeTarget = { runtime: 'host' }
      let localDiscoveryOptions: Parameters<typeof discoverCommitMessageModelsLocal>[3]
      if (args.worktreePath) {
        const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
        const gitOptions = getLocalGitOptionsForRegisteredWorktree(
          store,
          args.worktreePath,
          worktreePath
        )
        localRuntimeTarget = getLocalAgentRuntimeTarget(gitOptions)
        localDiscoveryOptions = gitOptions.wslDistro
          ? { cwd: worktreePath, wslDistro: gitOptions.wslDistro }
          : { cwd: worktreePath }
      }
      const localEnv = await prepareLocalCommitMessageAgentEnv(
        agentId,
        commitMessageAgentEnv,
        localRuntimeTarget
      )
      if (!localEnv.ok) {
        return { success: false, error: localEnv.error }
      }
      return localDiscoveryOptions
        ? discoverCommitMessageModelsLocal(
            agentId as TuiAgent,
            localEnv.env,
            agentCommandOverride,
            localDiscoveryOptions
          )
        : discoverCommitMessageModelsLocal(agentId as TuiAgent, localEnv.env, agentCommandOverride)
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
        provider?: HostedReviewProvider
        useTemplate?: boolean
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
          const currentBody = await resolveHostedReviewBodyForGeneration({
            body: args.body,
            repoPath: args.worktreePath,
            connectionId: args.connectionId,
            provider: args.provider,
            useTemplate: args.useTemplate
          })
          context = await getPullRequestDraftContext(
            (argv) => provider.exec(argv, args.worktreePath),
            {
              base: args.base,
              currentTitle: args.title,
              currentBody,
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      let context: Awaited<ReturnType<typeof getPullRequestDraftContext>>
      try {
        const currentBody = await resolveHostedReviewBodyForGeneration({
          body: args.body,
          repoPath: worktreePath,
          connectionId: args.connectionId,
          provider: args.provider,
          useTemplate: args.useTemplate
        })
        context = await getPullRequestDraftContext(
          (argv, options) =>
            gitExecFileAsync(argv, { cwd: worktreePath, ...gitOptions, ...options }),
          {
            base: args.base,
            currentTitle: args.title,
            currentBody,
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
        commitMessageAgentEnv,
        getLocalAgentRuntimeTarget(gitOptions)
      )
      if (!localEnv.ok) {
        return { success: false, error: localEnv.error }
      }
      return generatePullRequestFieldsFromContext(
        context,
        resolvedSettings.params,
        getLocalTextGenerationTarget(worktreePath, gitOptions, localEnv.env)
      )
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return getBranchCompare(worktreePath, args.baseRef, gitOptions)
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return getCommitCompare(worktreePath, commitId, gitOptions)
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return getUpstreamStatus(worktreePath, args.pushTarget, gitOptions)
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      if (args.pushTarget) {
        await validateGitPushTarget(worktreePath, args.pushTarget, gitOptions)
      }
      await gitFetch(worktreePath, args.pushTarget, gitOptions)
    }
  )

  ipcMain.handle(
    'git:syncFork',
    async (
      _event,
      args: {
        worktreePath: string
        connectionId?: string
        expectedUpstream: GitForkSyncExpectedUpstream
      }
    ): Promise<GitForkSyncResult> => {
      const expectedUpstream = validateGitForkSyncExpectedUpstream(args.expectedUpstream, {
        required: true
      })
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.syncForkDefaultBranch(args.worktreePath, expectedUpstream)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return gitSyncForkDefaultBranch(worktreePath, expectedUpstream, gitOptions)
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
      // Why: coerce to strict boolean so a malformed payload (e.g. string 'false') can't enable --set-upstream; mirror in src/relay/git-handler.ts.
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      if (args.pushTarget) {
        await validateGitPushTarget(worktreePath, args.pushTarget, gitOptions)
      }
      await gitPush(worktreePath, publish, args.pushTarget, {
        forceWithLease: args.forceWithLease === true,
        ...gitOptions
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      if (args.pushTarget) {
        await validateGitPushTarget(worktreePath, args.pushTarget, gitOptions)
      }
      await gitPull(worktreePath, args.pushTarget, gitOptions)
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      if (args.pushTarget) {
        await validateGitPushTarget(worktreePath, args.pushTarget, gitOptions)
      }
      await gitFastForward(worktreePath, args.pushTarget, gitOptions)
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await gitPullRebaseFromBase(worktreePath, args.baseRef, gitOptions)
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return getBranchDiff(
        worktreePath,
        {
          mergeBase: args.compare.mergeBase,
          headOid: args.compare.headOid,
          filePath,
          oldPath
        },
        gitOptions
      )
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      return getCommitDiff(
        worktreePath,
        {
          commitOid,
          parentOid,
          filePath,
          oldPath
        },
        gitOptions
      )
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await stageFile(worktreePath, filePath, gitOptions)
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await unstageFile(worktreePath, filePath, gitOptions)
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await discardChanges(worktreePath, filePath, gitOptions)
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await bulkDiscardChanges(worktreePath, filePaths, gitOptions)
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await bulkStageFiles(worktreePath, filePaths, gitOptions)
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
      const gitOptions = getLocalGitOptionsForRegisteredWorktree(
        store,
        args.worktreePath,
        worktreePath
      )
      await bulkUnstageFiles(worktreePath, filePaths, gitOptions)
    }
  )

  ipcMain.handle(
    'git:remoteFileUrl',
    async (
      _event,
      args: { worktreePath: string; relativePath: string; line: number; connectionId?: string }
    ): Promise<string | null> => {
      // Why: remote repos can't read relay-side .git/config locally; delegate URL construction to the SSH provider.
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

  ipcMain.handle(
    'git:remoteCommitUrl',
    async (
      _event,
      args: { worktreePath: string; sha: string; connectionId?: string }
    ): Promise<string | null> => {
      const sha = validateFullGitObjectId(args.sha, 'sha')
      // Why: remote repos can't read relay-side .git/config locally; delegate URL construction to the SSH provider.
      if (args.connectionId) {
        const provider = getSshGitProvider(args.connectionId)
        if (!provider) {
          throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
        }
        return provider.getRemoteCommitUrl(args.worktreePath, sha)
      }
      const worktreePath = await resolveRegisteredWorktreePath(args.worktreePath, store)
      return getRemoteCommitUrl(worktreePath, sha)
    }
  )

  registerLocalLogTailHandlers(store)
}
