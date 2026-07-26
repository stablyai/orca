/* eslint-disable max-lines -- Why: this module keeps local and SSH directory-walk
   semantics paired so reclaimable-byte, symlink, and partial-failure behavior cannot drift. */
import { lstat, opendir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { posix, win32 } from 'node:path'
import { platform } from 'node:process'
import type { Dirent } from 'node:fs'
import type { Store } from './persistence'
import { isFolderRepo } from '../shared/repo-kind'
import type { DirEntry, GitWorktreeInfo, Repo, Worktree } from '../shared/types'
import type {
  WorkspaceSpaceAnalysis,
  WorkspaceSpaceDirectoryScanResult,
  WorkspaceSpaceItem,
  WorkspaceSpaceRepoSummary,
  WorkspaceSpaceScanProgress,
  WorkspaceSpaceScanStatus,
  WorkspaceSpaceWorktree
} from '../shared/workspace-space-types'
import { compactWorkspaceSpaceItems } from '../shared/workspace-space-compaction'
import { mapWithConcurrency } from '../shared/map-with-concurrency'
import {
  scanWorkspaceSpaceEntryTree,
  type WorkspaceSpaceEntryScan
} from '../shared/workspace-space-entry-traversal'
import {
  collectWorkspaceSpaceDirectoryEntries,
  createWorkspaceSpaceScanBudget,
  WorkspaceSpaceScanCapacityError
} from '../shared/workspace-space-scan-budget'
import type { IFilesystemProvider } from './providers/types'
import { getSshFilesystemProvider } from './providers/ssh-filesystem-dispatch'
import { getSshGitProvider } from './providers/ssh-git-dispatch'
import { createFolderWorktree, listRepoWorktrees } from './repo-worktrees'
import { mergeWorktree } from './ipc/worktree-logic'

const WORKTREE_SCAN_CONCURRENCY = 3
const LOCAL_FS_CONCURRENCY = 48
const REMOTE_FS_CONCURRENCY = 10
const DU_TIMEOUT_MS = 120_000
const DU_MAX_BUFFER_BYTES = 16 * 1024 * 1024

type ScanStats = WorkspaceSpaceEntryScan

type WorktreeListResult =
  | { ok: true; worktrees: GitWorktreeInfo[] }
  | { ok: false; status: Exclude<WorkspaceSpaceScanStatus, 'ok'>; error: string }

type RepoScanResult = {
  summary: WorkspaceSpaceRepoSummary
  worktrees: WorkspaceSpaceWorktree[]
}

type WorkspaceSpaceAnalyzeOptions = {
  signal?: AbortSignal
  scanId?: string
  onProgress?: (progress: WorkspaceSpaceScanProgress) => void
}

type WorkspaceSpaceProgressState = WorkspaceSpaceScanProgress

export class WorkspaceSpaceScanCancelledError extends Error {
  constructor() {
    super('Workspace space scan cancelled')
    this.name = 'WorkspaceSpaceScanCancelledError'
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new WorkspaceSpaceScanCancelledError()
  }
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  return (error as { name?: unknown }).name === 'AbortError'
}

function isRelayMethodNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  return (error as { code?: unknown }).code === -32601
}

function looksLikeWindowsPath(pathValue: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.startsWith('\\\\')
}

function basenameFilesystemPath(pathValue: string): string {
  return looksLikeWindowsPath(pathValue) ? win32.basename(pathValue) : posix.basename(pathValue)
}

function joinFilesystemPath(parent: string, child: string): string {
  return looksLikeWindowsPath(parent) ? win32.join(parent, child) : posix.join(parent, child)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeLocalDuPath(pathValue: string): string {
  const separator = platform === 'win32' ? '\\' : '/'
  const trimmed = pathValue.replace(new RegExp(`${escapeRegExp(separator)}+$`), '')
  return trimmed.length > 0 ? trimmed : pathValue
}

function parseDuDepthOneOutput(stdout: string): Map<string, number> {
  const sizes = new Map<string, number>()
  for (const line of stdout.split('\n')) {
    const normalizedLine = line.endsWith('\r') ? line.slice(0, -1) : line
    if (!normalizedLine) {
      continue
    }
    const match = /^(\d+)\s+(.+)$/.exec(normalizedLine)
    if (!match) {
      continue
    }
    sizes.set(normalizeLocalDuPath(match[2]), Number(match[1]) * 1024)
  }
  return sizes
}

async function readLocalDuDepthOne(
  rootPath: string,
  signal?: AbortSignal
): Promise<Map<string, number>> {
  const stdout = await new Promise<string>((resolve, reject) => {
    let settled = false
    let child: ReturnType<typeof execFile> | undefined
    let onAbort: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      if (onAbort) {
        signal?.removeEventListener('abort', onAbort)
      }
      callback()
    }
    timer = setTimeout(() => {
      settle(() => {
        child?.kill()
        reject(new Error(`du timed out after ${DU_TIMEOUT_MS}ms`))
      })
    }, DU_TIMEOUT_MS)
    onAbort = () => {
      settle(() => {
        child?.kill()
        reject(new Error('Workspace space scan cancelled'))
      })
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }

    // Why: execFile's timeout only signals `du`; a wedged child that never
    // calls back must not block the Space scan or its portable fallback.
    try {
      child = execFile(
        'du',
        ['-k', '-d', '1', rootPath],
        {
          encoding: 'utf8',
          maxBuffer: DU_MAX_BUFFER_BYTES,
          signal,
          timeout: DU_TIMEOUT_MS
        },
        (error, stdout) => {
          if (error) {
            settle(() => reject(error))
            return
          }
          settle(() => resolve(String(stdout)))
        }
      )
    } catch (error) {
      settle(() => reject(error))
    }
  })
  return parseDuDepthOneOutput(stdout)
}

function classifyError(error: unknown): {
  status: Exclude<WorkspaceSpaceScanStatus, 'ok'>
  message: string
} {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: unknown }).code)
      : ''
  const message = error instanceof Error ? error.message : String(error)

  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return { status: 'missing', message }
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return { status: 'permission-denied', message }
  }
  return { status: 'error', message }
}

function toWorkspaceSpaceItem(stats: ScanStats): WorkspaceSpaceItem {
  return {
    name: stats.name,
    path: stats.path,
    kind: stats.kind,
    sizeBytes: stats.sizeBytes
  }
}

function createBaseWorktreeRow(
  repo: Repo,
  worktree: Worktree,
  scannedAt: number
): Omit<
  WorkspaceSpaceWorktree,
  | 'status'
  | 'error'
  | 'sizeBytes'
  | 'reclaimableBytes'
  | 'skippedEntryCount'
  | 'topLevelItems'
  | 'omittedTopLevelItemCount'
  | 'omittedTopLevelSizeBytes'
> {
  const canDelete = !worktree.isMainWorktree
  return {
    worktreeId: worktree.id,
    repoId: repo.id,
    repoDisplayName: repo.displayName,
    repoPath: repo.path,
    displayName: worktree.displayName,
    path: worktree.path,
    branch: worktree.branch,
    isMainWorktree: worktree.isMainWorktree,
    isRemote: Boolean(repo.connectionId),
    isSparse: worktree.isSparse === true,
    canDelete,
    lastActivityAt: worktree.lastActivityAt,
    scannedAt
  }
}

function createUnavailableWorktreeRow(
  repo: Repo,
  worktree: Worktree,
  scannedAt: number,
  status: Exclude<WorkspaceSpaceScanStatus, 'ok'>,
  error: string
): WorkspaceSpaceWorktree {
  return {
    ...createBaseWorktreeRow(repo, worktree, scannedAt),
    status,
    error,
    sizeBytes: 0,
    reclaimableBytes: 0,
    skippedEntryCount: 0,
    topLevelItems: [],
    omittedTopLevelItemCount: 0,
    omittedTopLevelSizeBytes: 0
  }
}

function createScannedWorktreeRow(
  repo: Repo,
  worktree: Worktree,
  scannedAt: number,
  scan: WorkspaceSpaceDirectoryScanResult
): WorkspaceSpaceWorktree {
  return {
    ...createBaseWorktreeRow(repo, worktree, scannedAt),
    status: 'ok',
    error: null,
    sizeBytes: scan.sizeBytes,
    reclaimableBytes: worktree.isMainWorktree ? 0 : scan.sizeBytes,
    skippedEntryCount: scan.skippedEntryCount,
    topLevelItems: scan.topLevelItems,
    omittedTopLevelItemCount: scan.omittedTopLevelItemCount,
    omittedTopLevelSizeBytes: scan.omittedTopLevelSizeBytes
  }
}

async function scanLocalEntry(
  entryPath: string,
  name: string,
  signal?: AbortSignal
): Promise<ScanStats> {
  return scanWorkspaceSpaceEntryTree<Dirent>({
    rootPath: entryPath,
    rootName: name,
    concurrency: LOCAL_FS_CONCURRENCY,
    signal,
    entryName: (entry) => entry.name,
    joinPath: joinFilesystemPath,
    classifyEntry: async (path) => {
      const stats = await lstat(path)
      throwIfAborted(signal)
      if (stats.isSymbolicLink()) {
        return { kind: 'symlink', sizeBytes: stats.size }
      }
      return stats.isDirectory()
        ? { kind: 'directory', sizeBytes: stats.size }
        : { kind: 'file', sizeBytes: stats.size }
    },
    readDirectory: (path) => opendir(path),
    checkCancelled: () => throwIfAborted(signal),
    createCancellationError: () => new WorkspaceSpaceScanCancelledError(),
    isCancellationError: (error) => error instanceof WorkspaceSpaceScanCancelledError
  })
}

async function scanRemoteEntry(
  entryPath: string,
  name: string,
  provider: IFilesystemProvider,
  signal?: AbortSignal
): Promise<ScanStats> {
  return scanWorkspaceSpaceEntryTree<DirEntry>({
    rootPath: entryPath,
    rootName: name,
    concurrency: REMOTE_FS_CONCURRENCY,
    signal,
    entryName: (entry) => entry.name,
    joinPath: joinFilesystemPath,
    classifyEntry: async (path, sourceEntry) => {
      if (sourceEntry?.isSymlink) {
        return { kind: 'symlink', sizeBytes: 0 }
      }
      const stats = await provider.stat(path)
      throwIfAborted(signal)
      if (stats.type === 'symlink') {
        return { kind: 'symlink', sizeBytes: stats.size }
      }
      return stats.type === 'directory'
        ? { kind: 'directory', sizeBytes: stats.size }
        : { kind: 'file', sizeBytes: stats.size }
    },
    readDirectory: (path) => provider.readDir(path),
    checkCancelled: () => throwIfAborted(signal),
    createCancellationError: () => new WorkspaceSpaceScanCancelledError(),
    isCancellationError: (error) => error instanceof WorkspaceSpaceScanCancelledError
  })
}

async function scanLocalTopLevelEntry(
  entryPath: string,
  name: string,
  duSizes: Map<string, number>,
  signal?: AbortSignal
): Promise<ScanStats> {
  throwIfAborted(signal)
  const stats = await lstat(entryPath)
  throwIfAborted(signal)

  if (stats.isSymbolicLink()) {
    return {
      name,
      path: entryPath,
      kind: 'symlink',
      sizeBytes: stats.size,
      skippedEntryCount: 0
    }
  }

  if (!stats.isDirectory()) {
    return {
      name,
      path: entryPath,
      kind: 'file',
      sizeBytes: stats.size,
      skippedEntryCount: 0
    }
  }

  return {
    name,
    path: entryPath,
    kind: 'directory',
    sizeBytes: duSizes.get(normalizeLocalDuPath(entryPath)) ?? stats.size,
    skippedEntryCount: 0
  }
}

async function scanLocalWorktreeWithDu(
  repo: Repo,
  worktree: Worktree,
  scannedAt: number,
  signal?: AbortSignal
): Promise<WorkspaceSpaceWorktree> {
  throwIfAborted(signal)
  const rootStats = await lstat(worktree.path)
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    const root = await scanLocalEntry(worktree.path, basenameFilesystemPath(worktree.path), signal)
    const compact = compactWorkspaceSpaceItems((root.children ?? []).map(toWorkspaceSpaceItem))
    return {
      ...createBaseWorktreeRow(repo, worktree, scannedAt),
      status: 'ok',
      error: null,
      sizeBytes: root.sizeBytes,
      reclaimableBytes: worktree.isMainWorktree ? 0 : root.sizeBytes,
      skippedEntryCount: root.skippedEntryCount,
      ...compact
    }
  }

  const [entries, duSizes] = await Promise.all([
    opendir(worktree.path).then((directory) =>
      collectWorkspaceSpaceDirectoryEntries(
        directory,
        worktree.path,
        (entry) => entry.name,
        createWorkspaceSpaceScanBudget(),
        () => throwIfAborted(signal)
      )
    ),
    readLocalDuDepthOne(worktree.path, signal)
  ])
  throwIfAborted(signal)
  const childStats = await mapWithConcurrency(
    entries,
    LOCAL_FS_CONCURRENCY,
    async (entry): Promise<ScanStats | null> => {
      try {
        return await scanLocalTopLevelEntry(
          joinFilesystemPath(worktree.path, entry.name),
          entry.name,
          duSizes,
          signal
        )
      } catch (error) {
        if (error instanceof WorkspaceSpaceScanCancelledError) {
          throw error
        }
        return null
      }
    }
  )
  const children = childStats.filter((child): child is ScanStats => child !== null)
  const skippedEntryCount = childStats.length - children.length
  const rootSize =
    duSizes.get(normalizeLocalDuPath(worktree.path)) ??
    rootStats.size + children.reduce((sum, child) => sum + child.sizeBytes, 0)
  const compact = compactWorkspaceSpaceItems(children.map(toWorkspaceSpaceItem))

  return {
    ...createBaseWorktreeRow(repo, worktree, scannedAt),
    status: 'ok',
    error: null,
    sizeBytes: rootSize,
    reclaimableBytes: worktree.isMainWorktree ? 0 : rootSize,
    skippedEntryCount,
    ...compact
  }
}

async function scanLocalWorktreeWithNode(
  repo: Repo,
  worktree: Worktree,
  scannedAt: number,
  signal?: AbortSignal
): Promise<WorkspaceSpaceWorktree> {
  try {
    const root = await scanLocalEntry(worktree.path, basenameFilesystemPath(worktree.path), signal)
    const compact = compactWorkspaceSpaceItems((root.children ?? []).map(toWorkspaceSpaceItem))
    return {
      ...createBaseWorktreeRow(repo, worktree, scannedAt),
      status: 'ok',
      error: null,
      sizeBytes: root.sizeBytes,
      reclaimableBytes: worktree.isMainWorktree ? 0 : root.sizeBytes,
      skippedEntryCount: root.skippedEntryCount,
      ...compact
    }
  } catch (error) {
    if (error instanceof WorkspaceSpaceScanCancelledError) {
      throw error
    }
    const classified = classifyError(error)
    return createUnavailableWorktreeRow(
      repo,
      worktree,
      scannedAt,
      classified.status,
      classified.message
    )
  }
}

async function scanLocalWorktree(
  repo: Repo,
  worktree: Worktree,
  scannedAt: number,
  signal?: AbortSignal
): Promise<WorkspaceSpaceWorktree> {
  throwIfAborted(signal)
  if (platform !== 'win32') {
    try {
      // Why: JS per-file stats are too slow for large local workspace fleets;
      // POSIX du gives bounded top-level sizing without following symlinks.
      return await scanLocalWorktreeWithDu(repo, worktree, scannedAt, signal)
    } catch (error) {
      throwIfAborted(signal)
      if (error instanceof WorkspaceSpaceScanCancelledError) {
        throw error
      }
      if (error instanceof WorkspaceSpaceScanCapacityError) {
        const classified = classifyError(error)
        return createUnavailableWorktreeRow(
          repo,
          worktree,
          scannedAt,
          classified.status,
          classified.message
        )
      }
      // Fall through to the portable scanner so unsupported du variants or
      // permission edge cases still produce partial rows instead of failing.
    }
  }
  return scanLocalWorktreeWithNode(repo, worktree, scannedAt, signal)
}

async function scanRemoteWorktree(
  repo: Repo,
  worktree: Worktree,
  scannedAt: number,
  provider: IFilesystemProvider,
  signal?: AbortSignal
): Promise<WorkspaceSpaceWorktree> {
  try {
    if (provider.scanWorkspaceSpace) {
      try {
        const scan = await provider.scanWorkspaceSpace(worktree.path, { signal })
        return createScannedWorktreeRow(repo, worktree, scannedAt, scan)
      } catch (error) {
        if (isAbortError(error)) {
          throw new WorkspaceSpaceScanCancelledError()
        }
        if (!isRelayMethodNotFoundError(error)) {
          throw error
        }
        // Why: old SSH relays do not know the bulk Space scan method. Fall
        // back to the request-by-request walker instead of marking SSH rows
        // unavailable after an app upgrade.
      }
    }

    const root = await scanRemoteEntry(
      worktree.path,
      basenameFilesystemPath(worktree.path),
      provider,
      signal
    )
    const compact = compactWorkspaceSpaceItems((root.children ?? []).map(toWorkspaceSpaceItem))
    return createScannedWorktreeRow(repo, worktree, scannedAt, {
      sizeBytes: root.sizeBytes,
      skippedEntryCount: root.skippedEntryCount,
      ...compact
    })
  } catch (error) {
    if (error instanceof WorkspaceSpaceScanCancelledError) {
      throw error
    }
    const classified = classifyError(error)
    return createUnavailableWorktreeRow(
      repo,
      worktree,
      scannedAt,
      classified.status,
      classified.message
    )
  }
}

async function listWorktreesForSpaceScan(
  repo: Repo,
  signal?: AbortSignal
): Promise<WorktreeListResult> {
  try {
    throwIfAborted(signal)
    if (isFolderRepo(repo)) {
      return { ok: true, worktrees: [createFolderWorktree(repo)] }
    }
    if (repo.connectionId) {
      const provider = getSshGitProvider(repo.connectionId)
      if (!provider) {
        return {
          ok: false,
          status: 'unavailable',
          error: `SSH connection "${repo.connectionId}" is not connected.`
        }
      }
      const worktrees = await provider.listWorktrees(repo.path, { signal })
      throwIfAborted(signal)
      return { ok: true, worktrees }
    }
    const worktrees = await listRepoWorktrees(repo)
    throwIfAborted(signal)
    return { ok: true, worktrees }
  } catch (error) {
    if (error instanceof WorkspaceSpaceScanCancelledError) {
      throw error
    }
    const classified = classifyError(error)
    return { ok: false, status: classified.status, error: classified.message }
  }
}

function mergeForSpaceScan(repo: Repo, gitWorktree: GitWorktreeInfo, store: Store): Worktree {
  const worktreeId = `${repo.id}::${gitWorktree.path}`
  return mergeWorktree(repo.id, gitWorktree, store.getWorktreeMeta(worktreeId), repo.displayName)
}

function reportProgress(
  progress: WorkspaceSpaceProgressState,
  updates: Partial<WorkspaceSpaceProgressState>,
  onProgress: WorkspaceSpaceAnalyzeOptions['onProgress']
): void {
  Object.assign(progress, updates, { updatedAt: Date.now() })
  onProgress?.({ ...progress })
}

async function scanRepo(
  repo: Repo,
  scannedAt: number,
  store: Store,
  progress: WorkspaceSpaceProgressState,
  options: WorkspaceSpaceAnalyzeOptions
): Promise<RepoScanResult> {
  throwIfAborted(options.signal)
  reportProgress(
    progress,
    {
      currentRepoDisplayName: repo.displayName,
      currentWorktreeDisplayName: null
    },
    options.onProgress
  )
  const listed = await listWorktreesForSpaceScan(repo, options.signal)
  if (!listed.ok) {
    reportProgress(
      progress,
      { scannedRepoCount: progress.scannedRepoCount + 1 },
      options.onProgress
    )
    return {
      worktrees: [],
      summary: {
        repoId: repo.id,
        displayName: repo.displayName,
        path: repo.path,
        isRemote: Boolean(repo.connectionId),
        worktreeCount: 0,
        scannedWorktreeCount: 0,
        unavailableWorktreeCount: 1,
        totalSizeBytes: 0,
        reclaimableBytes: 0,
        error: listed.error
      }
    }
  }

  // Why: a prunable registration has no directory to size or reclaim (issue
  // #8389); it would only render a dead "Missing" row with no available
  // action. Removal flows list worktrees separately and still see it.
  const worktrees = listed.worktrees
    .filter((gitWorktree) => !gitWorktree.prunable)
    .map((gitWorktree) => mergeForSpaceScan(repo, gitWorktree, store))
  reportProgress(
    progress,
    { totalWorktreeCount: progress.totalWorktreeCount + worktrees.length },
    options.onProgress
  )
  const remoteProvider = repo.connectionId ? getSshFilesystemProvider(repo.connectionId) : undefined
  const rows = await mapWithConcurrency(worktrees, WORKTREE_SCAN_CONCURRENCY, async (worktree) => {
    throwIfAborted(options.signal)
    reportProgress(
      progress,
      {
        currentRepoDisplayName: repo.displayName,
        currentWorktreeDisplayName: worktree.displayName
      },
      options.onProgress
    )
    const row: WorkspaceSpaceWorktree = repo.connectionId
      ? remoteProvider
        ? await scanRemoteWorktree(repo, worktree, scannedAt, remoteProvider, options.signal)
        : createUnavailableWorktreeRow(
            repo,
            worktree,
            scannedAt,
            'unavailable',
            `SSH filesystem for "${repo.connectionId}" is not connected.`
          )
      : await scanLocalWorktree(repo, worktree, scannedAt, options.signal)
    reportProgress(
      progress,
      { scannedWorktreeCount: progress.scannedWorktreeCount + 1 },
      options.onProgress
    )
    return row
  })
  reportProgress(
    progress,
    {
      scannedRepoCount: progress.scannedRepoCount + 1,
      currentRepoDisplayName: repo.displayName,
      currentWorktreeDisplayName: null
    },
    options.onProgress
  )

  return {
    worktrees: rows,
    summary: {
      repoId: repo.id,
      displayName: repo.displayName,
      path: repo.path,
      isRemote: Boolean(repo.connectionId),
      worktreeCount: rows.length,
      scannedWorktreeCount: rows.filter((row) => row.status === 'ok').length,
      unavailableWorktreeCount: rows.filter((row) => row.status !== 'ok').length,
      totalSizeBytes: rows.reduce((sum, row) => sum + row.sizeBytes, 0),
      reclaimableBytes: rows.reduce((sum, row) => sum + row.reclaimableBytes, 0),
      error: null
    }
  }
}

export async function analyzeWorkspaceSpace(
  store: Store,
  options: WorkspaceSpaceAnalyzeOptions = {}
): Promise<WorkspaceSpaceAnalysis> {
  throwIfAborted(options.signal)
  const scannedAt = Date.now()
  const reposToScan = store.getRepos()
  const progress: WorkspaceSpaceProgressState = {
    scanId: options.scanId ?? String(scannedAt),
    state: 'running',
    startedAt: scannedAt,
    updatedAt: scannedAt,
    totalRepoCount: reposToScan.length,
    scannedRepoCount: 0,
    totalWorktreeCount: 0,
    scannedWorktreeCount: 0,
    currentRepoDisplayName: null,
    currentWorktreeDisplayName: null
  }
  options.onProgress?.({ ...progress })
  const repoResults = await mapWithConcurrency(reposToScan, 2, (repo) =>
    scanRepo(repo, scannedAt, store, progress, options)
  )
  throwIfAborted(options.signal)
  const repos = repoResults.map((result) => result.summary)
  const worktrees = repoResults
    .flatMap((result) => result.worktrees)
    .sort((a, b) => b.sizeBytes - a.sizeBytes || a.displayName.localeCompare(b.displayName))
  throwIfAborted(options.signal)

  return {
    scannedAt,
    totalSizeBytes: worktrees.reduce((sum, row) => sum + row.sizeBytes, 0),
    reclaimableBytes: worktrees.reduce((sum, row) => sum + row.reclaimableBytes, 0),
    worktreeCount: worktrees.length,
    scannedWorktreeCount: worktrees.filter((row) => row.status === 'ok').length,
    unavailableWorktreeCount:
      worktrees.filter((row) => row.status !== 'ok').length +
      repos.filter((repo) => repo.error !== null).length,
    repos,
    worktrees
  }
}
