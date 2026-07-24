/* eslint-disable max-lines -- Why: filesystem, editor-file, and search commands share the same local/SSH path authorization rules. Keeping that IO adapter together prevents separate command paths from drifting on safety checks. */
import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { watch as watchFs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import {
  chmod,
  constants,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import type {
  DirEntry,
  FsChangeEvent,
  GitWorktreeInfo,
  MarkdownDocument,
  SearchOptions,
  SearchResult,
  Worktree
} from '../../shared/types'
import {
  isPathInsideOrEqual,
  isRuntimePathAbsolute,
  isWindowsAbsolutePathLike,
  normalizeRuntimePathForComparison,
  relativePathInsideRoot,
  resolveRuntimePath
} from '../../shared/cross-platform-path'
import { PhysicalExitTracker } from '../../shared/physical-exit-tracker'
import type {
  RuntimeFileListResult,
  RuntimeFileOpenResult,
  RuntimeFileReadChunkResult,
  RuntimeFilePreviewResult,
  RuntimeFileReadResult,
  RuntimeTerminalPathResolution
} from '../../shared/runtime-types'
import {
  closeFileExplorerWatcherInWatcherProcess,
  watchFileExplorerInWatcherProcess
} from './file-watcher-host'
import { wslAwareSpawn } from '../git/runner'
import { parseWslPath, toWindowsWslPath } from '../wsl'
import { isENOENT, resolveAuthorizedPath } from '../ipc/filesystem-auth'
import { listQuickOpenFiles } from '../ipc/filesystem-list-files'
import { searchWithGitGrep } from '../ipc/filesystem-search-git'
import { getLocalGitOptionsForRegisteredWorktree } from '../ipc/local-worktree-runtime-options'
import { checkRgAvailable } from '../ipc/rg-availability'
import {
  listMarkdownDocuments,
  markdownDocumentsFromRelativePaths
} from '../ipc/markdown-documents'
import {
  buildRgArgs,
  createAccumulator,
  DEFAULT_SEARCH_MAX_RESULTS,
  finalize,
  ingestRgJsonLine,
  SEARCH_TIMEOUT_MS
} from '../../shared/text-search'
import type { Store } from '../persistence'
import {
  getSshFilesystemProvider,
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-filesystem-dispatch'
import type { FileStat, IFilesystemProvider } from '../providers/types'
import {
  isWatcherProcessFailure,
  WatcherProcessFailure
} from '../ipc/parcel-watcher-process-failure'
import { assertNoClobberRenameDestinationAvailable } from '../../shared/filesystem-rename-collision'
import { joinWorktreeRelativePath, normalizeRuntimeRelativePath } from './runtime-relative-paths'
import {
  rankRuntimeMobileFilePaths,
  RuntimeMobileFilePathSearchCache
} from './runtime-mobile-file-path-search'
import { beginWatcherInstall } from '../ipc/watcher-removal-gate'
import { assertSshMutationExpectation } from '../ssh/ssh-connection-generation'
import { toSshExecutionHostId } from '../../shared/execution-host'

const MOBILE_FILE_LIST_LIMIT = 5000
const MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT = 20_000
const MOBILE_FILE_PATH_SEARCH_CACHE_ENTRIES = 8
const MOBILE_FILE_PATH_SEARCH_CACHE_TTL_MS = 30_000
const MOBILE_FILE_READ_MAX_BYTES = 512 * 1024
const RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES = 10 * 1024 * 1024
const WINDOWS_RUNTIME_FILE_WATCH_DEBOUNCE_MS = 150
export const WINDOWS_RUNTIME_FILE_WATCH_CLOSE_DEADLINE_MS = 10_000
const TERMINAL_FILE_GRANT_TTL_MS = 10 * 60 * 1000
const OPEN_NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0
const RUNTIME_FILE_MUTATION_UPDATE_REQUIRED =
  'Remote file changes require a newer Orca client. Update the paired client and try again.'

function assertRuntimeFileMutationExpectation(
  connectionId: string | undefined,
  expectedExecutionHostId: string | undefined,
  expectedSshTargetId: string | undefined,
  expectedSshConnectionGeneration: number | undefined
): void {
  if (!expectedExecutionHostId) {
    throw new Error(RUNTIME_FILE_MUTATION_UPDATE_REQUIRED)
  }
  const actualExecutionHostId = connectionId ? toSshExecutionHostId(connectionId) : 'local'
  if (expectedExecutionHostId !== actualExecutionHostId) {
    throw new Error('Workspace host changed; refresh and try again')
  }
  assertSshMutationExpectation(connectionId, expectedSshTargetId, expectedSshConnectionGeneration)
}
// Why: files.watch cleanup is synchronous RPC; track native Parcel unsubscribes so shutdown can drain them.
const pendingRuntimeFileWatcherUnsubscribes = new Set<Promise<void>>()

type RuntimeFileWatcherLease = {
  suspend(): Promise<void>
  resume(): Promise<void>
  forget(): void
}
const runtimeFileWatcherLeasesByOwnerAndRoot = new Map<string, Set<RuntimeFileWatcherLease>>()
const MOBILE_BINARY_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.heic',
  '.ico',
  '.jpeg',
  '.jpg',
  '.mov',
  '.mp3',
  '.mp4',
  '.pdf',
  '.png',
  '.webp',
  '.zip'
])
// Mirror of mobile classifyMobileArtifact's image set; SVG/PDF excluded because RN <Image> can't decode those data URIs.
const MOBILE_PREVIEWABLE_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico'
])

type RuntimeFileStatLike = {
  size?: number
  dev?: number
  ino?: number
  nlink?: number
  mtime?: number | Date
  mtimeMs?: number
  isDirectory?: () => boolean
}

type TerminalFileGrant = {
  id: string
  worktreeId: string
  absolutePath: string
  provider: 'local' | 'ssh'
  connectionId?: string
  clientId?: string
  expiresAt: number
  statIdentity: string | null
  expiryTimer?: ReturnType<typeof setTimeout>
}

function isMobilePreviewableImagePath(relativePath: string): boolean {
  const basename = basenameFromRelativePath(relativePath)
  const dotIndex = basename.lastIndexOf('.')
  if (dotIndex <= 0) {
    return false
  }
  return MOBILE_PREVIEWABLE_IMAGE_EXTENSIONS.has(basename.slice(dotIndex).toLowerCase())
}

const RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES: Record<string, string> = {
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

function trackRuntimeFileWatcherUnsubscribe(
  rootPath: string,
  unsubscribe: () => Promise<void>
): Promise<void> {
  const promise = Promise.resolve()
    .then(unsubscribe)
    .finally(() => {
      pendingRuntimeFileWatcherUnsubscribes.delete(promise)
    })
  pendingRuntimeFileWatcherUnsubscribes.add(promise)
  void promise.catch((err: unknown) => {
    console.error('[runtime-files.watch] unsubscribe error', { rootPath, err })
  })
  return promise
}

function normalizeRuntimeWatcherRoot(rootPath: string): string {
  return normalizeRuntimePathForComparison(rootPath)
}

function runtimeWatcherReleaseKey(
  runtimeId: string,
  connectionId: string | undefined,
  rootPath: string
): string {
  // Why: identical absolute paths exist on local and multiple SSH hosts; scope teardown to the host that owns it.
  return JSON.stringify([runtimeId, connectionId ?? null, normalizeRuntimeWatcherRoot(rootPath)])
}

function registerRuntimeFileWatcherRelease(
  runtimeId: string,
  connectionId: string | undefined,
  rootPaths: string[],
  unsubscribe: () => Promise<void>,
  restart: () => Promise<() => Promise<void>>,
  onRestoreError: (error: Error) => void
): () => Promise<void> {
  const keys = Array.from(
    new Set(
      rootPaths.map((rootPath) => runtimeWatcherReleaseKey(runtimeId, connectionId, rootPath))
    )
  )
  let currentUnsubscribe: (() => Promise<void>) | null = unsubscribe
  let releasePromise: Promise<void> | null = null
  let physicalExitPromise: Promise<void> | null = null
  let resumePromise: Promise<void> | null = null
  let stopPromise: Promise<void> | null = null
  let logicallyStopped = false
  const removeLease = (): void => {
    for (const key of keys) {
      const leases = runtimeFileWatcherLeasesByOwnerAndRoot.get(key)
      leases?.delete(lease)
      if (leases?.size === 0) {
        runtimeFileWatcherLeasesByOwnerAndRoot.delete(key)
      }
    }
  }
  const suspend = (): Promise<void> => {
    if (releasePromise) {
      return releasePromise
    }
    const release = currentUnsubscribe
    if (!release) {
      return Promise.resolve()
    }
    const attempt = trackRuntimeFileWatcherUnsubscribe(rootPaths[0], release)
    releasePromise = attempt
    void attempt.then(
      () => {
        if (currentUnsubscribe === release) {
          currentUnsubscribe = null
        }
        releasePromise = null
      },
      (error: unknown) => {
        if (isWatcherProcessFailure(error) && error.physicalExit) {
          const physicalExit = error.physicalExit.then(() => {
            if (currentUnsubscribe === release) {
              currentUnsubscribe = null
            }
            releasePromise = null
            if (physicalExitPromise === physicalExit) {
              physicalExitPromise = null
            }
            if (logicallyStopped) {
              removeLease()
            }
          })
          physicalExitPromise = physicalExit
        } else {
          // Why: a synchronous close failure retains the native owner so a later removal or unsubscribe can retry the same handle.
          releasePromise = null
        }
      }
    )
    return attempt
  }
  const lease: RuntimeFileWatcherLease = {
    suspend,
    resume: () => {
      if (logicallyStopped || (currentUnsubscribe && !physicalExitPromise)) {
        return Promise.resolve()
      }
      if (resumePromise) {
        return physicalExitPromise ? Promise.resolve() : resumePromise
      }
      // Why: a timed-out child still owns native handles until physical exit; join that owner before starting a replacement.
      const resumesAfterPhysicalExit = physicalExitPromise !== null
      const attempt = Promise.resolve(physicalExitPromise ?? releasePromise)
        .then(async () => {
          if (logicallyStopped) {
            return
          }
          const nextUnsubscribe = await restart()
          if (logicallyStopped) {
            await nextUnsubscribe()
            return
          }
          currentUnsubscribe = nextUnsubscribe
        })
        .catch((error: unknown) => {
          const restoreError = error instanceof Error ? error : new Error(String(error))
          queueMicrotask(() => onRestoreError(restoreError))
          throw restoreError
        })
        .finally(() => {
          resumePromise = null
        })
      resumePromise = attempt
      if (resumesAfterPhysicalExit) {
        void attempt.catch(() => {})
        return Promise.resolve()
      }
      return attempt
    },
    forget: () => {
      logicallyStopped = true
      removeLease()
    }
  }
  for (const key of keys) {
    const leases = runtimeFileWatcherLeasesByOwnerAndRoot.get(key) ?? new Set()
    leases.add(lease)
    runtimeFileWatcherLeasesByOwnerAndRoot.set(key, leases)
  }
  return () => {
    if (stopPromise) {
      return stopPromise
    }
    logicallyStopped = true
    const release =
      resumePromise && !physicalExitPromise
        ? Promise.resolve(resumePromise)
            .catch(() => undefined)
            .then(suspend)
        : suspend()
    const attempt = release.then(removeLease).catch((error: unknown) => {
      stopPromise = null
      throw error
    })
    stopPromise = attempt
    return attempt
  }
}

export async function awaitRuntimeFileWatcherUnsubscribes(): Promise<void> {
  await Promise.allSettled(Array.from(pendingRuntimeFileWatcherUnsubscribes))
}

export function _getRuntimeFileWatcherReleaseCountForTests(): number {
  const leases = new Set<RuntimeFileWatcherLease>()
  for (const rootLeases of runtimeFileWatcherLeasesByOwnerAndRoot.values()) {
    for (const lease of rootLeases) {
      leases.add(lease)
    }
  }
  return leases.size
}

export function _resetRuntimeFileWatcherLeasesForTests(): void {
  const leases = new Set<RuntimeFileWatcherLease>()
  for (const rootLeases of runtimeFileWatcherLeasesByOwnerAndRoot.values()) {
    for (const lease of rootLeases) {
      leases.add(lease)
    }
  }
  for (const lease of leases) {
    lease.forget()
  }
  runtimeFileWatcherLeasesByOwnerAndRoot.clear()
}

export type ResolvedRuntimeFileWorktree = Worktree & { git: GitWorktreeInfo }
export type ResolvedRuntimeFileTarget = {
  worktree: ResolvedRuntimeFileWorktree
  connectionId?: string
}

export type RuntimeFileCommandHost = {
  getRuntimeId(): string
  requireStore(): Store
  resolveWorktreeSelector(selector: string): Promise<ResolvedRuntimeFileWorktree>
  resolveRuntimeFileTarget(selector: string): Promise<ResolvedRuntimeFileTarget>
  resolveTerminalCwd?(terminalHandle: string): string | null | Promise<string | null>
  resolveTerminalContext?(
    terminalHandle: string
  ): { worktreeId: string; connectionId: string | null } | null
  resolveTerminalFileUriHostname?(terminalHandle: string): string | null | Promise<string | null>
  hasRecentTerminalOutputPath?(
    terminalHandle: string,
    pathText: string,
    absolutePath: string
  ): boolean | Promise<boolean>
  resolveRuntimeGitTarget(
    selector: string
  ): Promise<{ worktree: ResolvedRuntimeFileWorktree; connectionId?: string }>
  openFile(
    worktreeId: string,
    filePath: string,
    relativePath: string,
    runtimeEnvironmentId?: string | null
  ): void
  openDiff(
    worktreeId: string,
    filePath: string,
    relativePath: string,
    staged: boolean,
    runtimeEnvironmentId?: string | null
  ): void
}

export class RuntimeFileCommands {
  private activeRuntimeTextSearches = new Map<string, ChildProcess>()
  private terminalFileGrants = new Map<string, TerminalFileGrant>()
  private mobileFilePathSearchCache = new RuntimeMobileFilePathSearchCache(
    MOBILE_FILE_PATH_SEARCH_CACHE_ENTRIES,
    MOBILE_FILE_PATH_SEARCH_CACHE_TTL_MS
  )

  constructor(private readonly host: RuntimeFileCommandHost) {}

  async listMobileFiles(worktreeSelector: string): Promise<RuntimeFileListResult> {
    const store = this.host.requireStore()
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree, connectionId } = target
    const files = connectionId
      ? await this.listRemoteMobileFiles(worktree.path, connectionId)
      : await listQuickOpenFiles(worktree.path, store)
    const entries = files
      .filter((relativePath) => isSafeMobileRelativePath(relativePath))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, MOBILE_FILE_LIST_LIMIT)
      .map((relativePath) => ({
        relativePath,
        basename: basenameFromRelativePath(relativePath),
        kind: isMobileBinaryPath(relativePath) ? ('binary' as const) : ('text' as const)
      }))

    return {
      worktree: worktree.id,
      rootPath: worktree.path,
      files: entries,
      totalCount: files.length,
      truncated: files.length > MOBILE_FILE_LIST_LIMIT
    }
  }

  async searchMobileFilePaths(
    worktreeSelector: string,
    query: string,
    limit: number
  ): Promise<RuntimeFileListResult> {
    const store = this.host.requireStore()
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree, connectionId } = target
    const cacheKey = `${connectionId ?? 'local'}:${worktree.id}:${worktree.path}`
    const inventory = await this.mobileFilePathSearchCache.get(cacheKey, async () => {
      const listed = connectionId
        ? await this.listRemoteMobileFiles(
            worktree.path,
            connectionId,
            MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT + 1
          )
        : await listQuickOpenFiles(
            worktree.path,
            store,
            undefined,
            undefined,
            MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT + 1
          )
      const safePaths = listed
        .filter((relativePath) => isSafeMobileRelativePath(relativePath))
        .sort((a, b) => a.localeCompare(b))
      return {
        paths: safePaths.slice(0, MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT),
        totalCount: safePaths.length,
        truncated: safePaths.length > MOBILE_FILE_PATH_SEARCH_CACHE_LIMIT
      }
    })
    const matches = rankRuntimeMobileFilePaths(inventory.paths, query, limit)
    return {
      worktree: worktree.id,
      rootPath: worktree.path,
      files: matches.paths.map((relativePath) => ({
        relativePath,
        basename: basenameFromRelativePath(relativePath),
        kind: isMobileBinaryPath(relativePath) ? ('binary' as const) : ('text' as const)
      })),
      totalCount: matches.totalCount,
      truncated: inventory.truncated || matches.totalCount > limit
    }
  }

  async openMobileFile(
    worktreeSelector: string,
    relativePath: string
  ): Promise<RuntimeFileOpenResult> {
    const { worktree, connectionId } = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    if (!isSafeMobileRelativePath(relativePath)) {
      throw new Error('invalid_relative_path')
    }
    // Previewable images open like text (mobile renders via files.readPreview); other binaries stay unavailable on mobile.
    const kind = isMobilePreviewableImagePath(relativePath)
      ? 'image'
      : isMobileBinaryPath(relativePath)
        ? 'binary'
        : isMobileMarkdownPath(relativePath)
          ? 'markdown'
          : 'text'
    if (kind === 'binary') {
      return { worktree: worktree.id, relativePath, kind, opened: false }
    }
    const filePath = joinWorktreeRelativePath(worktree.path, relativePath)
    // Why: CLI/agents treat opened:true as success; stat first so missing paths fail the RPC instead of opening a ghost tab.
    await this.assertMobileOpenTargetExists(filePath, connectionId)
    // Why: the internal runtimeId isn't a valid env selector; pass undefined so openFile falls back to activeRuntimeEnvironmentId.
    this.host.openFile(worktree.id, filePath, relativePath, undefined)
    return { worktree: worktree.id, relativePath, kind, opened: true }
  }

  private async assertMobileOpenTargetExists(
    filePath: string,
    connectionId?: string
  ): Promise<void> {
    try {
      await (connectionId
        ? this.statRemoteTerminalPath(filePath, connectionId)
        : stat(await resolveAuthorizedPath(filePath, this.host.requireStore())))
    } catch (error) {
      if (
        isENOENT(error) ||
        (connectionId && RuntimeFileCommands.isRemoteNotFoundErrorMessage(error))
      ) {
        throw new Error(`ENOENT: no such file or directory, open '${filePath}'`)
      }
      throw error
    }
  }

  async openMobileDiff(
    worktreeSelector: string,
    relativePath: string,
    staged: boolean
  ): Promise<RuntimeFileOpenResult> {
    const { worktree } = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    if (!isSafeMobileRelativePath(relativePath)) {
      throw new Error('invalid_relative_path')
    }
    const kind = isMobileBinaryPath(relativePath)
      ? 'binary'
      : isMobileMarkdownPath(relativePath)
        ? 'markdown'
        : 'text'
    const filePath = joinWorktreeRelativePath(worktree.path, relativePath)
    // Why: see openMobileFile; avoid stamping internal runtimeId as runtimeEnvironmentId.
    this.host.openDiff(worktree.id, filePath, relativePath, staged, undefined)
    return { worktree: worktree.id, relativePath, kind, opened: true }
  }

  async readMobileFile(
    worktreeSelector: string,
    relativePath: string
  ): Promise<RuntimeFileReadResult> {
    const store = this.host.requireStore()
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree, connectionId } = target
    if (!isSafeMobileRelativePath(relativePath)) {
      throw new Error('invalid_relative_path')
    }
    if (isMobileBinaryPath(relativePath)) {
      throw new Error('binary_file')
    }

    const filePath = joinWorktreeRelativePath(worktree.path, relativePath)
    const content = connectionId
      ? await this.readRemoteMobileFile(filePath, connectionId)
      : await readLocalMobileFile(filePath, store)
    const truncated = truncateMobileFilePreview(content)

    return {
      worktree: worktree.id,
      relativePath,
      content: truncated.content,
      truncated: truncated.truncated,
      byteLength: truncated.byteLength
    }
  }

  // Resolves a mobile terminal tap to a worktree-relative path; relatives resolve against cwd, else the worktree root.
  async resolveTerminalPath(
    worktreeSelector: string,
    pathText: string,
    cwd?: string | null,
    clientId?: string,
    terminalHandle?: string | null
  ): Promise<RuntimeTerminalPathResolution> {
    const store = this.host.requireStore()
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const { worktree, connectionId } = target
    // Why: mobile may attach after OSC7 cwd was emitted; the runtime still owns the terminal's latest cwd to resolve the tap.
    const normalizedTerminalHandle =
      terminalHandle && terminalHandle.trim().length > 0 ? terminalHandle.trim() : null
    const terminalCwd = normalizedTerminalHandle
      ? await this.host.resolveTerminalCwd?.(normalizedTerminalHandle)
      : null
    const terminalFileUriHostname = normalizedTerminalHandle
      ? await this.host.resolveTerminalFileUriHostname?.(normalizedTerminalHandle)
      : null
    const base = terminalCwd || (cwd && cwd.trim().length > 0 ? cwd : worktree.path)

    const empty: RuntimeTerminalPathResolution = {
      worktree: worktree.id,
      relativePath: null,
      absolutePath: null,
      exists: false,
      isDirectory: false
    }

    // Why: remote home is unknown (only local os.homedir), so a tapped ~/… on a remote worktree is not-openable, not guessed.
    const isTilde = pathText.startsWith('~/') || pathText.startsWith('~\\')
    if (isTilde && connectionId) {
      return empty
    }
    const expanded = isTilde ? resolveRuntimePath(homedir(), pathText.slice(2)) : pathText
    const absolutePath = resolveTerminalAbsolutePath({
      base,
      expanded,
      worktreePath: worktree.path,
      connectionId,
      terminalFileUriHostname
    })
    const relativePath = relativePathInsideRoot(worktree.path, absolutePath)

    try {
      if (relativePath !== null && relativePath !== '' && isSafeMobileRelativePath(relativePath)) {
        const stats = connectionId
          ? await this.statRemoteTerminalPath(absolutePath, connectionId)
          : await stat(await resolveAuthorizedPath(absolutePath, store))
        return {
          worktree: worktree.id,
          relativePath,
          absolutePath,
          exists: true,
          isDirectory: stats.isDirectory(),
          openTarget: stats.isDirectory()
            ? undefined
            : {
                kind: 'worktree-file',
                provider: connectionId ? 'ssh' : 'local',
                relativePath,
                absolutePath
              }
        }
      }

      // Why: mobile taps may hit agent artifacts outside the worktree; grant the exact path, not arbitrary absolute paths.
      if (!normalizedTerminalHandle || !terminalCwd) {
        return { ...empty, relativePath, absolutePath }
      }
      const terminalContext = this.host.resolveTerminalContext?.(normalizedTerminalHandle)
      if (
        !terminalContext ||
        terminalContext.worktreeId !== worktree.id ||
        (terminalContext.connectionId ?? undefined) !== connectionId
      ) {
        return { ...empty, relativePath, absolutePath }
      }
      const artifactPath = await this.resolveAllowedTerminalArtifactPath({
        absolutePath,
        connectionId,
        worktreePath: worktree.path
      })
      if (!artifactPath) {
        return { ...empty, relativePath, absolutePath }
      }
      if (
        !(await this.host.hasRecentTerminalOutputPath?.(
          normalizedTerminalHandle,
          provenancePathCandidate(pathText, absolutePath),
          artifactPath
        ))
      ) {
        return { ...empty, relativePath, absolutePath }
      }
      const stats = connectionId
        ? await this.statRemoteTerminalPath(artifactPath, connectionId)
        : await this.statLocalTerminalPath(artifactPath)
      const isDirectory = stats.isDirectory()
      if (!isDirectory && isTerminalArtifactHardLinked(stats)) {
        return { ...empty, relativePath, absolutePath }
      }
      const grant = isDirectory
        ? null
        : this.createTerminalFileGrant({
            worktreeId: worktree.id,
            absolutePath: artifactPath,
            provider: connectionId ? 'ssh' : 'local',
            connectionId,
            clientId,
            stats
          })
      return {
        worktree: worktree.id,
        relativePath: null,
        absolutePath: artifactPath,
        exists: true,
        isDirectory,
        openTarget: grant
          ? {
              kind: 'absolute-file',
              provider: grant.provider,
              absolutePath: artifactPath,
              grantId: grant.id
            }
          : undefined
      }
    } catch (error) {
      // Report genuine not-found as missing; let transport/permission errors surface so remote taps aren't all reported missing.
      if (
        isENOENT(error) ||
        (connectionId && RuntimeFileCommands.isRemoteNotFoundErrorMessage(error))
      ) {
        return { ...empty, relativePath, absolutePath }
      }
      throw error
    }
  }

  // The mux drops ErrnoException.code, so match not-found by message shape (vs transport/permission/provider errors).
  private static isRemoteNotFoundErrorMessage(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error)
    return /\bENOENT\b|no such file|not found|does not exist/i.test(message)
  }

  private async statRemoteTerminalPath(
    absolutePath: string,
    connectionId: string
  ): Promise<RuntimeFileStatLike & { isDirectory: () => boolean }> {
    const provider = getSshFilesystemProvider(connectionId)
    if (!provider) {
      throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
    }
    const stats = await provider.stat(absolutePath)
    return { ...stats, isDirectory: () => stats.type === 'directory' }
  }

  private async resolveAllowedTerminalArtifactPath(args: {
    absolutePath: string
    connectionId?: string
    worktreePath: string
  }): Promise<string | null> {
    if (args.connectionId) {
      return this.resolveAllowedRemoteTerminalArtifactPath(args.absolutePath, args.connectionId)
    }
    return resolveAllowedLocalTerminalArtifactPath(args.absolutePath, args.worktreePath)
  }

  private async resolveAllowedRemoteTerminalArtifactPath(
    absolutePath: string,
    connectionId: string
  ): Promise<string | null> {
    const provider = getSshFilesystemProvider(connectionId)
    if (!provider) {
      throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
    }
    const roots = ['/tmp', '/private/tmp']
    const providerTempDir = await provider.getTempDir?.().catch(() => null)
    if (providerTempDir) {
      roots.push(providerTempDir)
    }
    if (!roots.some((root) => isPathInsideOrEqual(root, absolutePath))) {
      return null
    }
    const [realArtifactPath, ...realRoots] = await Promise.all([
      provider.realpath(absolutePath),
      ...roots.map((root) => provider.realpath(root).catch(() => root))
    ])
    // Why: SSH I/O follows symlinks on the relay; grant the canonical target so a /tmp link can't escape the temp boundary.
    return realRoots.some((root) => isPathInsideOrEqual(root, realArtifactPath))
      ? realArtifactPath
      : null
  }

  private async statLocalTerminalPath(
    absolutePath: string
  ): Promise<RuntimeFileStatLike & { isDirectory: () => boolean }> {
    await assertLocalTerminalArtifactPathStillCanonical(absolutePath)
    const handle = await open(absolutePath, 'r')
    try {
      return handle.stat()
    } finally {
      await handle.close()
    }
  }

  private createTerminalFileGrant(args: {
    worktreeId: string
    absolutePath: string
    provider: 'local' | 'ssh'
    connectionId?: string
    clientId?: string
    stats: RuntimeFileStatLike
  }): TerminalFileGrant {
    assertTerminalArtifactNotHardLinked(args.stats)
    const grant: TerminalFileGrant = {
      id: randomUUID(),
      worktreeId: args.worktreeId,
      absolutePath: args.absolutePath,
      provider: args.provider,
      ...(args.connectionId ? { connectionId: args.connectionId } : {}),
      ...(args.clientId ? { clientId: args.clientId } : {}),
      expiresAt: Date.now() + TERMINAL_FILE_GRANT_TTL_MS,
      statIdentity: terminalFileStatIdentity(args.stats)
    }
    this.terminalFileGrants.set(grant.id, grant)
    this.scheduleTerminalFileGrantExpiry(grant)
    return grant
  }

  private async requireTerminalFileGrant(
    worktreeSelector: string,
    grantId: string,
    absolutePath: string,
    clientId?: string
  ): Promise<{ grant: TerminalFileGrant; target: ResolvedRuntimeFileTarget }> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    this.pruneExpiredTerminalFileGrants()
    const grant = this.terminalFileGrants.get(grantId)
    if (!grant) {
      throw new Error('terminal_file_grant_expired')
    }
    if (grant.expiresAt <= Date.now()) {
      this.releaseTerminalFileGrant(grantId, grant)
      throw new Error('terminal_file_grant_expired')
    }
    if (
      grant.worktreeId !== target.worktree.id ||
      grant.absolutePath !== absolutePath ||
      grant.connectionId !== target.connectionId ||
      grant.clientId !== clientId
    ) {
      throw new Error('terminal_file_grant_mismatch')
    }
    return { grant, target }
  }

  private refreshTerminalFileGrant(grant: TerminalFileGrant): void {
    grant.expiresAt = Date.now() + TERMINAL_FILE_GRANT_TTL_MS
    this.scheduleTerminalFileGrantExpiry(grant)
  }

  private pruneExpiredTerminalFileGrants(): void {
    const now = Date.now()
    for (const [id, grant] of this.terminalFileGrants) {
      if (grant.expiresAt <= now) {
        this.releaseTerminalFileGrant(id, grant)
      }
    }
  }

  revokeTerminalFileGrantsForClient(clientId: string): void {
    for (const [id, grant] of this.terminalFileGrants) {
      if (grant.clientId === clientId) {
        this.releaseTerminalFileGrant(id, grant)
      }
    }
  }

  private releaseTerminalFileGrant(id: string, grant: TerminalFileGrant): void {
    this.terminalFileGrants.delete(id)
    if (grant.expiryTimer) {
      clearTimeout(grant.expiryTimer)
      grant.expiryTimer = undefined
    }
  }

  private scheduleTerminalFileGrantExpiry(grant: TerminalFileGrant): void {
    if (grant.expiryTimer) {
      clearTimeout(grant.expiryTimer)
    }
    grant.expiryTimer = setTimeout(
      () => {
        if (this.terminalFileGrants.get(grant.id) === grant && grant.expiresAt <= Date.now()) {
          this.releaseTerminalFileGrant(grant.id, grant)
        }
      },
      Math.max(1, grant.expiresAt - Date.now())
    )
    grant.expiryTimer.unref?.()
  }

  async readTerminalArtifactFile(
    worktreeSelector: string,
    grantId: string,
    absolutePath: string,
    clientId?: string
  ): Promise<RuntimeFileReadResult> {
    const { grant, target } = await this.requireTerminalFileGrant(
      worktreeSelector,
      grantId,
      absolutePath,
      clientId
    )
    if (isMobileBinaryPath(grant.absolutePath)) {
      throw new Error('binary_file')
    }
    let content: string
    if (grant.connectionId) {
      const provider = await this.assertRemoteTerminalFileGrantFreshForRead(grant)
      content = await this.readRemoteTerminalArtifactFile(
        provider,
        grant,
        MOBILE_FILE_READ_MAX_BYTES
      )
    } else {
      const handle = await openLocalTerminalArtifactGrant(grant, constants.O_RDONLY)
      try {
        content = await readLocalTerminalArtifactFileFromHandle(handle, grant)
      } finally {
        await handle.close()
      }
    }
    this.refreshTerminalFileGrant(grant)
    const truncated = truncateMobileFilePreview(content)

    return {
      worktree: target.worktree.id,
      relativePath: grant.absolutePath,
      content: truncated.content,
      truncated: truncated.truncated,
      byteLength: truncated.byteLength
    }
  }

  async readTerminalArtifactPreview(
    worktreeSelector: string,
    grantId: string,
    absolutePath: string,
    clientId?: string
  ): Promise<RuntimeFilePreviewResult> {
    const { grant } = await this.requireTerminalFileGrant(
      worktreeSelector,
      grantId,
      absolutePath,
      clientId
    )
    if (grant.connectionId) {
      const provider = await this.assertRemoteTerminalFileGrantFreshForRead(grant)
      this.refreshTerminalFileGrant(grant)
      return this.readRemoteTerminalArtifactPreview(provider, grant)
    }
    const handle = await openLocalTerminalArtifactGrant(grant, constants.O_RDONLY)
    try {
      const preview = await readLocalTerminalArtifactPreviewFromHandle(handle, grant)
      this.refreshTerminalFileGrant(grant)
      return preview
    } finally {
      await handle.close()
    }
  }

  async writeTerminalArtifactFile(
    worktreeSelector: string,
    grantId: string,
    absolutePath: string,
    content: string,
    clientId?: string
  ): Promise<{ ok: true }> {
    if (Buffer.byteLength(content, 'utf8') > MOBILE_FILE_READ_MAX_BYTES) {
      throw new Error('file_too_large')
    }
    const { grant } = await this.requireTerminalFileGrant(
      worktreeSelector,
      grantId,
      absolutePath,
      clientId
    )
    if (isMobileBinaryPath(grant.absolutePath)) {
      throw new Error('binary_file')
    }
    if (grant.connectionId) {
      const { provider, fileStat } = await this.assertRemoteTerminalFileGrantFresh(grant)
      if (fileStat.type === 'directory') {
        throw new Error('Cannot write to a directory')
      }
      if (fileStat.size > MOBILE_FILE_READ_MAX_BYTES) {
        throw new Error('file_too_large')
      }
      if (!provider.writeTerminalArtifact) {
        throw new Error('terminal_file_grant_unavailable')
      }
      const nextStat = await provider.writeTerminalArtifact(
        grant.absolutePath,
        content,
        this.terminalArtifactAccessOptions(grant, MOBILE_FILE_READ_MAX_BYTES)
      )
      grant.statIdentity = terminalFileStatIdentity(nextStat)
      this.refreshTerminalFileGrant(grant)
      return { ok: true }
    }

    let originalMode: number | null = null
    const handle = await openLocalTerminalArtifactGrant(grant, constants.O_RDONLY)
    try {
      const fileStats = await handle.stat()
      originalMode = fileStats.mode
      if (fileStats.isDirectory()) {
        throw new Error('Cannot write to a directory')
      }
      if (fileStats.size > MOBILE_FILE_READ_MAX_BYTES) {
        throw new Error('file_too_large')
      }
      assertTerminalFileGrantFresh(grant, fileStats)
      if (
        isBinaryBuffer(await readFileHandleBufferBounded(handle, MOBILE_FILE_READ_MAX_BYTES + 1))
      ) {
        throw new Error('binary_file')
      }
    } finally {
      await handle.close()
    }
    const tempPath = join(
      dirname(grant.absolutePath),
      `.${basename(grant.absolutePath)}.${randomUUID()}.tmp`
    )
    try {
      await writeFile(tempPath, content, { encoding: 'utf-8', flag: 'wx' })
      if (typeof originalMode === 'number') {
        await chmod(tempPath, originalMode & 0o7777)
      }
      const freshHandle = await openLocalTerminalArtifactGrant(grant, constants.O_RDONLY)
      try {
        assertTerminalFileGrantFresh(grant, await freshHandle.stat())
      } finally {
        await freshHandle.close()
      }
      await rename(tempPath, grant.absolutePath)
      grant.statIdentity = terminalFileStatIdentity(
        await this.statLocalTerminalPath(grant.absolutePath)
      )
      this.refreshTerminalFileGrant(grant)
      return { ok: true }
    } finally {
      await rm(tempPath, { force: true }).catch(() => {})
    }
  }

  private async readRemoteTerminalArtifactPreview(
    provider: IFilesystemProvider,
    grant: TerminalFileGrant
  ): Promise<RuntimeFilePreviewResult> {
    const preview = await this.readRemoteTerminalArtifact(
      provider,
      grant,
      RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES
    )
    if (
      !preview.isBinary &&
      Buffer.byteLength(preview.content, 'utf8') > MOBILE_FILE_READ_MAX_BYTES
    ) {
      throw new Error('file_too_large')
    }
    return preview
  }

  private async readRemoteTerminalArtifactFile(
    provider: IFilesystemProvider,
    grant: TerminalFileGrant,
    maxBytes: number
  ): Promise<string> {
    const result = await this.readRemoteTerminalArtifact(provider, grant, maxBytes)
    if (result.isBinary) {
      throw new Error('binary_file')
    }
    return result.content
  }

  private async readRemoteTerminalArtifact(
    provider: IFilesystemProvider,
    grant: TerminalFileGrant,
    maxBytes: number
  ): Promise<RuntimeFilePreviewResult> {
    if (!provider.readTerminalArtifact) {
      throw new Error('terminal_file_grant_unavailable')
    }
    return provider.readTerminalArtifact(
      grant.absolutePath,
      this.terminalArtifactAccessOptions(grant, maxBytes)
    )
  }

  private terminalArtifactAccessOptions(
    grant: TerminalFileGrant,
    maxBytes: number
  ): { expectedRealPath: string; expectedStatIdentity: string | null; maxBytes: number } {
    return {
      expectedRealPath: grant.absolutePath,
      expectedStatIdentity: grant.statIdentity,
      maxBytes
    }
  }

  private async assertRemoteTerminalFileGrantFreshForRead(
    grant: TerminalFileGrant
  ): Promise<IFilesystemProvider> {
    const { provider } = await this.assertRemoteTerminalFileGrantFresh(grant)
    return provider
  }

  private async assertRemoteTerminalFileGrantFresh(
    grant: TerminalFileGrant
  ): Promise<{ provider: IFilesystemProvider; fileStat: FileStat }> {
    const provider = await this.assertRemoteTerminalFileGrantPathStillCanonical(grant)
    const fileStat = await provider.stat(grant.absolutePath)
    assertTerminalFileGrantFresh(grant, fileStat)
    return { provider, fileStat }
  }

  private async assertRemoteTerminalFileGrantPathStillCanonical(
    grant: TerminalFileGrant
  ): Promise<IFilesystemProvider> {
    if (!grant.connectionId) {
      throw new Error('terminal_file_grant_mismatch')
    }
    const provider = getSshFilesystemProvider(grant.connectionId)
    if (!provider) {
      throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
    }
    const allowedPath = await this.resolveAllowedRemoteTerminalArtifactPath(
      grant.absolutePath,
      grant.connectionId
    )
    // Why: relay I/O follows symlinks, so re-canonicalize a remote temp-artifact grant after the process can mutate it.
    if (allowedPath !== grant.absolutePath) {
      throw new Error('terminal_file_grant_stale')
    }
    return provider
  }

  async readFileExplorerDir(worktreeSelector: string, relativePath: string): Promise<DirEntry[]> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.readDir(target.path)
    }

    const dirPath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    const entries = await readdir(dirPath, { withFileTypes: true })
    const mapped = await Promise.all(
      entries.map(async (entry) => {
        const entryPath = join(dirPath, entry.name)
        return {
          name: entry.name,
          isDirectory: await isRuntimeDirectoryEntry(entry, entryPath),
          isSymlink: entry.isSymbolicLink()
        }
      })
    )
    return mapped.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1
      }
      return a.name.localeCompare(b.name)
    })
  }

  async watchFileExplorer(
    worktreeSelector: string,
    callback: (events: FsChangeEvent[]) => void,
    onTerminalError: (error: Error) => void = () => undefined,
    signal?: AbortSignal
  ): Promise<() => void> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, '')
    const open = async (): Promise<{
      unsubscribe: () => Promise<void>
      rootPaths: string[]
    }> => {
      const finishInstall = beginWatcherInstall(target.path, target.connectionId)
      try {
        const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
        if (target.connectionId) {
          if (!provider) {
            throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
          }
          // Why: the RPC layer already threads AbortSignal for local watches; SSH must cancel the remote fs.watch, not wait it out.
          const close = await provider.watch(target.path, callback, { signal, onTerminalError })
          return { unsubscribe: async () => close(), rootPaths: [target.path] }
        }

        const rootPath = await resolveAuthorizedPath(target.path, this.host.requireStore())
        const rootStats = await stat(rootPath)
        if (!rootStats.isDirectory()) {
          throw new Error('not_a_directory')
        }
        if (process.platform === 'win32') {
          const close = watchWindowsRuntimeFileExplorer(rootPath, callback, onTerminalError)
          return { unsubscribe: close, rootPaths: [target.path, rootPath] }
        }
        // Why: the forked watcher keeps the blocking crawl and native faults out of the main/`serve` process (issues #5308, #8212).
        const dispose = await watchFileExplorerInWatcherProcess(
          rootPath,
          callback,
          onTerminalError,
          signal
        )
        return { unsubscribe: dispose, rootPaths: [target.path, rootPath] }
      } finally {
        finishInstall()
      }
    }
    const initial = await open()
    return registerRuntimeFileWatcherRelease(
      this.host.getRuntimeId(),
      target.connectionId,
      initial.rootPaths,
      initial.unsubscribe,
      async () => (await open()).unsubscribe,
      onTerminalError
    )
  }

  async closeFileExplorerWatchersForPath(rootPath: string, connectionId?: string): Promise<void> {
    const key = runtimeWatcherReleaseKey(this.host.getRuntimeId(), connectionId, rootPath)
    const leases = runtimeFileWatcherLeasesByOwnerAndRoot.get(key)
    if (leases) {
      await Promise.all(Array.from(leases, (lease) => lease.suspend()))
    }
    if (!connectionId) {
      // Why: setup can fail before registerRuntimeFileWatcherRelease publishes its callback while the child owner still lives.
      const resolvedRootPath = await resolveAuthorizedPath(rootPath, this.host.requireStore())
      await closeFileExplorerWatcherInWatcherProcess(resolvedRootPath)
    }
  }

  async restoreFileExplorerWatchersAfterFailedRemoval(
    rootPath: string,
    connectionId?: string
  ): Promise<void> {
    const key = runtimeWatcherReleaseKey(this.host.getRuntimeId(), connectionId, rootPath)
    const leases = runtimeFileWatcherLeasesByOwnerAndRoot.get(key)
    if (leases) {
      await Promise.all(Array.from(leases, (lease) => lease.resume()))
    }
  }

  forgetFileExplorerWatchersAfterRemoval(rootPath: string, connectionId?: string): void {
    const key = runtimeWatcherReleaseKey(this.host.getRuntimeId(), connectionId, rootPath)
    const leases = runtimeFileWatcherLeasesByOwnerAndRoot.get(key)
    if (leases) {
      for (const lease of Array.from(leases)) {
        lease.forget()
      }
    }
  }

  async readFileExplorerPreview(
    worktreeSelector: string,
    relativePath: string
  ): Promise<RuntimeFilePreviewResult> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      const fileStats = await provider.stat(target.path)
      if (fileStats.size > RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES) {
        throw new Error('file_too_large')
      }
      const result = await provider.readFile(target.path)
      return result
    }

    const filePath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    const fileStats = await stat(filePath)
    const mimeType = RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES[extname(filePath).toLowerCase()]
    if (mimeType) {
      if (fileStats.size > RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES) {
        throw new Error('file_too_large')
      }
      const buffer = await readFile(filePath)
      return {
        content: buffer.toString('base64'),
        isBinary: true,
        isImage: true,
        mimeType
      }
    }

    if (fileStats.size > MOBILE_FILE_READ_MAX_BYTES) {
      throw new Error('file_too_large')
    }
    const buffer = await readFile(filePath)
    if (isBinaryBuffer(buffer)) {
      return { content: '', isBinary: true }
    }
    return { content: buffer.toString('utf-8'), isBinary: false }
  }

  async readFileExplorerChunk(
    worktreeSelector: string,
    relativePath: string,
    offset: number,
    length: number
  ): Promise<RuntimeFileReadChunkResult> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      const fileStat = await provider.stat(target.path)
      if (fileStat.type === 'directory') {
        throw new Error('Cannot download a directory')
      }
      throw new Error('SSH runtime chunked download is unavailable; use the SSH download path')
    }

    const filePath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    const fileStats = await stat(filePath)
    if (fileStats.isDirectory()) {
      throw new Error('Cannot download a directory')
    }
    const handle = await open(filePath, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(length, Math.max(0, fileStats.size - offset)))
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset)
      const chunk = buffer.subarray(0, bytesRead)
      return {
        contentBase64: chunk.toString('base64'),
        bytesRead,
        eof: offset + bytesRead >= fileStats.size
      }
    } finally {
      await handle.close()
    }
  }

  async writeFileExplorerFile(
    worktreeSelector: string,
    relativePath: string,
    content: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.writeFile(target.path, content)
      return { ok: true }
    }

    const filePath = await resolveAuthorizedPath(target.path, this.host.requireStore())
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
    await writeFile(filePath, content, 'utf-8')
    return { ok: true }
  }

  async writeFileExplorerFileBase64(
    worktreeSelector: string,
    relativePath: string,
    contentBase64: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    const content = Buffer.from(contentBase64, 'base64')
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.writeFileBase64(target.path, contentBase64)
      return { ok: true }
    }

    const filePath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content, { flag: 'wx' })
    return { ok: true }
  }

  async writeFileExplorerFileBase64Chunk(
    worktreeSelector: string,
    relativePath: string,
    contentBase64: string,
    append: boolean,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    const content = Buffer.from(contentBase64, 'base64')
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.writeFileBase64Chunk(target.path, contentBase64, append)
      return { ok: true }
    }

    const filePath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content, { flag: append ? 'a' : 'wx' })
    return { ok: true }
  }

  async createFileExplorerFile(
    worktreeSelector: string,
    relativePath: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.createFile(target.path)
      return { ok: true }
    }

    const filePath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    await mkdir(dirname(filePath), { recursive: true })
    try {
      await writeFile(filePath, '', { encoding: 'utf-8', flag: 'wx' })
    } catch (error) {
      rethrowRuntimeFileCreateError(error, filePath)
    }
    return { ok: true }
  }

  async createFileExplorerDir(
    worktreeSelector: string,
    relativePath: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.createDir(target.path)
      return { ok: true }
    }

    const dirPath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    await assertRuntimePathDoesNotExist(dirPath)
    await mkdir(dirPath, { recursive: false })
    return { ok: true }
  }

  async createFileExplorerDirNoClobber(
    worktreeSelector: string,
    relativePath: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.createDirNoClobber(target.path)
      return { ok: true }
    }

    const dirPath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    await mkdir(dirPath, { recursive: false })
    return { ok: true }
  }

  async commitFileExplorerUpload(
    worktreeSelector: string,
    tempRelativePath: string,
    finalRelativePath: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const [tempTarget, finalTarget] = await this.resolveFileExplorerPaths(worktreeSelector, [
      tempRelativePath,
      finalRelativePath
    ])
    assertRuntimeFileMutationExpectation(
      tempTarget.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = tempTarget.connectionId
      ? getSshFilesystemProvider(tempTarget.connectionId)
      : null
    if (tempTarget.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.copy(tempTarget.path, finalTarget.path)
      await provider.deletePath(tempTarget.path, false).catch(() => {})
      return { ok: true }
    }

    const store = this.host.requireStore()
    const tempPath = await resolveAuthorizedPath(tempTarget.path, store)
    const finalPath = await resolveAuthorizedPath(finalTarget.path, store)
    await mkdir(dirname(finalPath), { recursive: true })
    await copyFile(tempPath, finalPath, constants.COPYFILE_EXCL)
    await rm(tempPath, { force: true })
    return { ok: true }
  }

  async renameFileExplorerPath(
    worktreeSelector: string,
    oldRelativePath: string,
    newRelativePath: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const [oldTarget, newTarget] = await this.resolveFileExplorerPaths(worktreeSelector, [
      oldRelativePath,
      newRelativePath
    ])
    assertRuntimeFileMutationExpectation(
      oldTarget.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = oldTarget.connectionId
      ? getSshFilesystemProvider(oldTarget.connectionId)
      : null
    if (oldTarget.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.renameNoClobber(oldTarget.path, newTarget.path)
      return { ok: true }
    }

    const store = this.host.requireStore()
    const oldPath = await resolveAuthorizedPath(oldTarget.path, store, { preserveSymlink: true })
    const newPath = await resolveAuthorizedPath(newTarget.path, store, { preserveSymlink: true })
    await assertNoClobberRenameDestinationAvailable(oldPath, newPath)
    await rename(oldPath, newPath)
    return { ok: true }
  }

  async copyFileExplorerPath(
    worktreeSelector: string,
    sourceRelativePath: string,
    destinationRelativePath: string,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const [sourceTarget, destinationTarget] = await this.resolveFileExplorerPaths(
      worktreeSelector,
      [sourceRelativePath, destinationRelativePath]
    )
    assertRuntimeFileMutationExpectation(
      sourceTarget.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = sourceTarget.connectionId
      ? getSshFilesystemProvider(sourceTarget.connectionId)
      : null
    if (sourceTarget.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.copy(sourceTarget.path, destinationTarget.path)
      return { ok: true }
    }

    const store = this.host.requireStore()
    const sourcePath = await resolveAuthorizedPath(sourceTarget.path, store, {
      preserveSymlink: true
    })
    const destinationPath = await resolveAuthorizedPath(destinationTarget.path, store, {
      preserveSymlink: true
    })
    await mkdir(dirname(destinationPath), { recursive: true })
    // Why: COPYFILE_EXCL preserves the no-clobber invariant of the local shell copy IPC (caller already deconflicts names).
    await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL)
    return { ok: true }
  }

  async deleteFileExplorerPath(
    worktreeSelector: string,
    relativePath: string,
    recursive?: boolean,
    expectedSshConnectionGeneration?: number,
    expectedSshTargetId?: string,
    expectedExecutionHostId?: string
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    assertRuntimeFileMutationExpectation(
      target.connectionId,
      expectedExecutionHostId,
      expectedSshTargetId,
      expectedSshConnectionGeneration
    )
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      await provider.deletePath(target.path, recursive)
      return { ok: true }
    }

    const targetPath = await resolveAuthorizedPath(target.path, this.host.requireStore(), {
      preserveSymlink: true
    })
    // Why: a non-local runtime has no client Trash; this delete is permanent, so the renderer confirms before calling.
    await rm(targetPath, { recursive: recursive === true, force: true })
    return { ok: true }
  }

  async searchRuntimeFiles(
    worktreeSelector: string,
    options: Omit<SearchOptions, 'rootPath'>
  ): Promise<SearchResult> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    const rootPath = target.worktree.path
    const searchOptions = { ...options, rootPath }
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return provider.search(searchOptions)
    }
    return this.searchLocalRuntimeFiles(rootPath, searchOptions)
  }

  async listRuntimeFiles(
    worktreeSelector: string,
    options: { excludePaths?: string[] } = {}
  ): Promise<string[]> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        return []
      }
      return provider.listFiles(target.worktree.path, { excludePaths: options.excludePaths })
    }
    return listQuickOpenFiles(target.worktree.path, this.host.requireStore(), options.excludePaths)
  }

  async listRuntimeMarkdownDocuments(worktreeSelector: string): Promise<MarkdownDocument[]> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      const relativePaths = await provider.listFiles(target.worktree.path)
      return markdownDocumentsFromRelativePaths(target.worktree.path, relativePaths)
    }
    return listMarkdownDocuments(target.worktree.path)
  }

  async statRuntimeFile(
    worktreeSelector: string,
    relativePath: string
  ): Promise<{ size: number; isDirectory: boolean; mtime: number }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      const fileStat = await provider.stat(target.path)
      return {
        size: fileStat.size,
        isDirectory: fileStat.type === 'directory',
        mtime: fileStat.mtime
      }
    }
    const filePath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    const stats = await stat(filePath)
    return { size: stats.size, isDirectory: stats.isDirectory(), mtime: stats.mtimeMs }
  }

  private async searchLocalRuntimeFiles(
    rootPath: string,
    options: SearchOptions
  ): Promise<SearchResult> {
    const store = this.host.requireStore()
    const authorizedRootPath = await resolveAuthorizedPath(rootPath, store)
    const localGitOptions = getLocalGitOptionsForRegisteredWorktree(
      store,
      rootPath,
      authorizedRootPath
    )
    const maxResults = Math.max(
      1,
      Math.min(options.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS, DEFAULT_SEARCH_MAX_RESULTS)
    )
    const rgAvailable = await checkRgAvailable(authorizedRootPath, localGitOptions.wslDistro)
    if (!rgAvailable) {
      return searchWithGitGrep(authorizedRootPath, options, maxResults, localGitOptions)
    }

    return new Promise((resolvePromise) => {
      const searchKey = `${this.host.getRuntimeId()}:${authorizedRootPath}`
      const rgArgs = buildRgArgs(options.query, authorizedRootPath, options)
      this.activeRuntimeTextSearches.get(searchKey)?.kill()

      const acc = createAccumulator()
      let stdoutBuffer = ''
      let resolved = false
      let child: ChildProcess | null = null
      const wslInfo = parseWslPath(authorizedRootPath)
      const transformAbsPath = wslInfo
        ? (p: string): string => toWindowsWslPath(p, wslInfo.distro)
        : undefined

      const resolveOnce = (): void => {
        if (resolved) {
          return
        }
        resolved = true
        if (this.activeRuntimeTextSearches.get(searchKey) === child) {
          this.activeRuntimeTextSearches.delete(searchKey)
        }
        cleanupListeners()
        resolvePromise(finalize(acc))
      }

      let killTimeout: ReturnType<typeof setTimeout> | null = null
      const cleanupListeners = (): void => {
        if (killTimeout) {
          clearTimeout(killTimeout)
          killTimeout = null
        }
        child?.stdout?.off('data', onStdoutData)
        child?.stderr?.off('data', onStderrData)
        child?.off('error', onError)
        child?.off('close', onClose)
      }

      const processLine = (line: string): void => {
        const verdict = ingestRgJsonLine(
          line,
          authorizedRootPath,
          acc,
          maxResults,
          transformAbsPath
        )
        if (verdict === 'stop') {
          child?.kill()
        }
      }

      const nextChild = wslAwareSpawn('rg', rgArgs, {
        cwd: authorizedRootPath,
        ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
        stdio: ['ignore', 'pipe', 'pipe']
      })
      child = nextChild
      this.activeRuntimeTextSearches.set(searchKey, nextChild)

      nextChild.stdout!.setEncoding('utf-8')
      const onStdoutData = (chunk: string): void => {
        stdoutBuffer += chunk
        const lines = stdoutBuffer.split('\n')
        stdoutBuffer = lines.pop() ?? ''
        for (const line of lines) {
          processLine(line)
        }
      }
      const onStderrData = (): void => {
        // Drain stderr so rg cannot block on a full pipe.
      }
      const onError = (): void => resolveOnce()
      const onClose = (): void => {
        if (stdoutBuffer) {
          processLine(stdoutBuffer)
        }
        resolveOnce()
      }

      nextChild.stdout!.on('data', onStdoutData)
      nextChild.stderr!.on('data', onStderrData)
      nextChild.once('error', onError)
      nextChild.once('close', onClose)

      killTimeout = setTimeout(() => {
        acc.truncated = true
        child?.kill()
        resolveOnce()
      }, SEARCH_TIMEOUT_MS)
    })
  }

  private async resolveFileExplorerPath(
    worktreeSelector: string,
    relativePath: string
  ): Promise<{ worktree: ResolvedRuntimeFileWorktree; path: string; connectionId?: string }> {
    const [target] = await this.resolveFileExplorerPaths(worktreeSelector, [relativePath])
    return target
  }

  private async resolveFileExplorerPaths(
    worktreeSelector: string,
    relativePaths: readonly string[]
  ): Promise<{ worktree: ResolvedRuntimeFileWorktree; path: string; connectionId?: string }[]> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    return relativePaths.map((relativePath) => ({
      worktree: target.worktree,
      path: joinWorktreeRelativePath(
        target.worktree.path,
        normalizeRuntimeRelativePath(relativePath)
      ),
      connectionId: target.connectionId
    }))
  }

  private async listRemoteMobileFiles(
    rootPath: string,
    connectionId: string,
    maxResults?: number
  ): Promise<string[]> {
    const provider = getSshFilesystemProvider(connectionId)
    if (!provider) {
      return []
    }
    return provider.listFiles(rootPath, { maxResults })
  }

  private async readRemoteMobileFile(filePath: string, connectionId: string): Promise<string> {
    const provider = getSshFilesystemProvider(connectionId)
    if (!provider) {
      throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
    }
    const fileStat = await provider.stat(filePath)
    // Why: no ranged reads over SSH here, so reject oversized previews instead of streaming a whole file just to trim it.
    if (fileStat.size > MOBILE_FILE_READ_MAX_BYTES) {
      throw new Error('file_too_large')
    }
    const result = await provider.readFile(filePath)
    if (result.isBinary) {
      throw new Error('binary_file')
    }
    return result.content
  }
}

function watchWindowsRuntimeFileExplorer(
  rootPath: string,
  callback: (events: FsChangeEvent[]) => void,
  onTerminalError: (error: Error) => void
): () => Promise<void> {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let closeStarted = false
  const physicalClose = new PhysicalExitTracker()

  const emitOverflow = (): void => {
    timer = null
    if (disposed) {
      return
    }
    callback([{ kind: 'overflow', absolutePath: rootPath }])
  }

  const scheduleOverflow = (): void => {
    if (disposed) {
      return
    }
    if (timer) {
      clearTimeout(timer)
    }
    timer = setTimeout(emitOverflow, WINDOWS_RUNTIME_FILE_WATCH_DEBOUNCE_MS)
  }

  // Why: Parcel's Watchman probe can crash the headless server on Windows; use a conservative overflow refresh instead.
  const watcher = watchFs(rootPath, { recursive: true }, scheduleOverflow)
  const onClose = (): void => {
    watcher.removeListener('error', onError)
    physicalClose.markExited()
  }
  const onError = (err: Error): void => {
    console.error('[runtime-files.watch] Windows watcher error', { rootPath, err })
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    watcher.removeListener('close', onClose)
    watcher.removeListener('error', onError)
    // Why: Node nulls FSWatcher's native handle on error without a close event; treat the error as physical-exit proof.
    physicalClose.markExited()
    if (!disposed) {
      try {
        callback([{ kind: 'overflow', absolutePath: rootPath }])
      } finally {
        onTerminalError(err)
      }
    }
  }
  watcher.once('close', onClose)
  watcher.on('error', onError)

  return async () => {
    disposed = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!closeStarted) {
      try {
        watcher.close()
      } catch (err) {
        console.error('[runtime-files.watch] Windows watcher close error', { rootPath, err })
        throw err
      }
      closeStarted = true
    }
    try {
      await physicalClose.waitForExit(
        WINDOWS_RUNTIME_FILE_WATCH_CLOSE_DEADLINE_MS,
        () => new Error('Windows watcher did not close before deletion deadline')
      )
    } catch (error) {
      // Why: late Windows close still owns native dir handles; expose its completion so cleanup retains then clears the root.
      throw new WatcherProcessFailure(
        error instanceof Error ? error.message : String(error),
        'supervisor',
        'process_unavailable',
        physicalClose.exitedPromise
      )
    }
  }
}

export function isSafeMobileRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(relativePath)) {
    return false
  }
  const parts = relativePath.replace(/\\/g, '/').split('/')
  return parts.every((part) => part !== '' && part !== '.' && part !== '..')
}

function isMobileMarkdownPath(relativePath: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(relativePath)
}

function isMobileBinaryPath(relativePath: string): boolean {
  const basename = basenameFromRelativePath(relativePath)
  const dotIndex = basename.lastIndexOf('.')
  if (dotIndex <= 0) {
    return false
  }
  return MOBILE_BINARY_EXTENSIONS.has(basename.slice(dotIndex).toLowerCase())
}

function basenameFromRelativePath(relativePath: string): string {
  const normalized = relativePath.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

async function isRuntimeDirectoryEntry(
  entry: { isDirectory(): boolean; isSymbolicLink(): boolean },
  _entryPath: string
): Promise<boolean> {
  // Why: listings are passive UI reads; don't stat symlink targets here (explicit open/expand resolves them).
  if (entry.isSymbolicLink()) {
    void _entryPath
    return false
  }
  if (entry.isDirectory()) {
    return true
  }
  return false
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const len = Math.min(buffer.length, 8192)
  for (let i = 0; i < len; i += 1) {
    if (buffer[i] === 0) {
      return true
    }
  }
  return false
}

async function assertRuntimePathDoesNotExist(targetPath: string): Promise<void> {
  try {
    await lstat(targetPath)
    throw new Error(
      `A file or folder named '${basename(targetPath)}' already exists in this location`
    )
  } catch (error) {
    if (!isENOENT(error)) {
      throw error
    }
  }
}

function rethrowRuntimeFileCreateError(error: unknown, targetPath: string): never {
  const name = basename(targetPath)
  if (error instanceof Error && 'code' in error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') {
      throw new Error(`A file or folder named '${name}' already exists in this location`)
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new Error(`Permission denied: unable to create '${name}'`)
    }
  }
  throw error
}

async function readLocalMobileFile(filePath: string, store: Store): Promise<string> {
  const authorizedPath = await resolveAuthorizedPath(filePath, store)
  const fileStat = await stat(authorizedPath)
  // Why: cap the read so opening a large file can't block the WebSocket (previews are read-only convenience views).
  const readLimit = Math.min(fileStat.size, MOBILE_FILE_READ_MAX_BYTES + 1)
  const handle = await open(authorizedPath, 'r')
  try {
    const buffer = Buffer.alloc(readLimit)
    const { bytesRead } = await handle.read(buffer, 0, readLimit, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

async function readLocalTerminalArtifactFileFromHandle(
  handle: FileHandle,
  grant: TerminalFileGrant
): Promise<string> {
  const fileStat = await handle.stat()
  if (fileStat.isDirectory()) {
    throw new Error('Cannot read a directory')
  }
  if (fileStat.size > MOBILE_FILE_READ_MAX_BYTES) {
    throw new Error('file_too_large')
  }
  assertTerminalFileGrantFresh(grant, fileStat)
  const buffer = await readFileHandleBufferBounded(handle, MOBILE_FILE_READ_MAX_BYTES + 1)
  if (isBinaryBuffer(buffer)) {
    throw new Error('binary_file')
  }
  return buffer.toString('utf8')
}

async function readLocalTerminalArtifactPreviewFromHandle(
  handle: FileHandle,
  grant: TerminalFileGrant
): Promise<RuntimeFilePreviewResult> {
  const fileStats = await handle.stat()
  if (fileStats.isDirectory()) {
    throw new Error('Cannot preview a directory')
  }
  assertTerminalFileGrantFresh(grant, fileStats)
  const mimeType = RUNTIME_PREVIEWABLE_BINARY_MIME_TYPES[extname(grant.absolutePath).toLowerCase()]
  if (mimeType) {
    if (fileStats.size > RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES) {
      throw new Error('file_too_large')
    }
    const buffer = await readFileHandleBufferBounded(
      handle,
      RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES + 1
    )
    return {
      content: buffer.toString('base64'),
      isBinary: true,
      isImage: true,
      mimeType
    }
  }

  const content = await readLocalTerminalArtifactFileFromHandle(handle, grant)
  return { content, isBinary: false }
}

async function assertLocalTerminalArtifactPathStillCanonical(filePath: string): Promise<void> {
  const currentPath = await canonicalPathForArtifactComparison(filePath)
  if (currentPath !== filePath) {
    throw new Error('terminal_file_grant_stale')
  }
}

async function openLocalTerminalArtifactGrant(
  grant: TerminalFileGrant,
  flags: number
): Promise<FileHandle> {
  await assertLocalTerminalArtifactPathStillCanonical(grant.absolutePath)
  try {
    return await open(grant.absolutePath, flags | OPEN_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new Error('terminal_file_grant_stale')
    }
    throw error
  }
}

function resolveTerminalAbsolutePath(args: {
  base: string
  expanded: string
  worktreePath: string
  connectionId?: string
  terminalFileUriHostname?: string | null
}): string {
  const expanded = normalizeTerminalFileUriAuthorityPath(
    args.expanded,
    args.connectionId,
    args.terminalFileUriHostname,
    args.worktreePath
  )
  const absolutePath = isRuntimePathAbsolute(expanded)
    ? expanded
    : resolveRuntimePath(args.base, expanded)
  if (args.connectionId) {
    return normalizeLeadingSlashDrivePath(absolutePath, args.worktreePath)
  }
  const wsl = parseWslPath(args.worktreePath)
  if (wsl && absolutePath.startsWith('/') && !absolutePath.startsWith('//')) {
    return toWindowsWslPath(absolutePath, wsl.distro)
  }
  return absolutePath
}

function normalizeTerminalFileUriAuthorityPath(
  pathText: string,
  connectionId?: string,
  terminalFileUriHostname?: string | null,
  worktreePath?: string
): string {
  if (!pathText.startsWith('//')) {
    return pathText
  }
  const match = /^\/\/([^/\\]+)([/\\].*)$/.exec(pathText)
  if (!match) {
    return pathText
  }
  const host = match[1]!.toLowerCase()
  if (terminalFileUriHostname && host === terminalFileUriHostname.toLowerCase() && connectionId) {
    return normalizeLeadingSlashDrivePath(match[2]!, worktreePath)
  }
  if (isLoopbackFileUriHostname(host) && (connectionId || process.platform !== 'win32')) {
    return normalizeLeadingSlashDrivePath(match[2]!, worktreePath)
  }
  // Why: without a verified host match, stripping the file-URI authority could open a same-path artifact on the wrong machine.
  return pathText
}

function provenancePathCandidate(pathText: string, absolutePath: string): string {
  return pathText.startsWith('//') ? pathText : absolutePath
}

function isLoopbackFileUriHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

function normalizeLeadingSlashDrivePath(pathText: string, worktreePath?: string): string {
  return worktreePath &&
    isWindowsAbsolutePathLike(worktreePath) &&
    /^\/[A-Za-z]:[\\/]/.test(pathText)
    ? pathText.slice(1)
    : pathText
}

async function resolveAllowedLocalTerminalArtifactPath(
  absolutePath: string,
  worktreePath: string
): Promise<string | null> {
  const roots = await localTerminalArtifactRoots(worktreePath)
  const canonicalPath = await canonicalPathForArtifactComparison(absolutePath)
  return roots.some((root) => isPathInsideOrEqual(root, canonicalPath)) ? canonicalPath : null
}

async function localTerminalArtifactRoots(worktreePath: string): Promise<string[]> {
  const roots = new Set<string>([tmpdir()])
  if (process.platform !== 'win32') {
    roots.add('/tmp')
    roots.add('/private/tmp')
  }
  const wsl = parseWslPath(worktreePath)
  if (wsl) {
    roots.add(toWindowsWslPath('/tmp', wsl.distro))
  }
  const canonicalRoots = await Promise.all(
    Array.from(roots).map((root) => canonicalPathForArtifactComparison(root))
  )
  return Array.from(new Set([...roots, ...canonicalRoots]))
}

async function canonicalPathForArtifactComparison(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

async function readFileHandleBufferBounded(handle: FileHandle, limit: number): Promise<Buffer> {
  const buffer = Buffer.alloc(limit)
  const { bytesRead } = await handle.read(buffer, 0, limit, 0)
  return buffer.subarray(0, bytesRead)
}

function terminalFileStatIdentity(stats: RuntimeFileStatLike): string | null {
  const dev = typeof stats.dev === 'number' ? stats.dev : null
  const ino = typeof stats.ino === 'number' ? stats.ino : null
  const nlink = typeof stats.nlink === 'number' ? stats.nlink : null
  const size = typeof stats.size === 'number' ? stats.size : null
  const mtimeMs =
    typeof stats.mtimeMs === 'number'
      ? stats.mtimeMs
      : typeof stats.mtime === 'number'
        ? stats.mtime
        : null
  if (dev !== null && ino !== null && size !== null && mtimeMs !== null) {
    return `${dev}:${ino}:${nlink ?? 'unknown'}:${size}:${mtimeMs}`
  }
  if (size !== null && mtimeMs !== null) {
    return `${size}:${mtimeMs}`
  }
  return null
}

function assertTerminalFileGrantFresh(grant: TerminalFileGrant, stats: RuntimeFileStatLike): void {
  assertTerminalArtifactNotHardLinked(stats)
  const nextIdentity = terminalFileStatIdentity(stats)
  if (grant.statIdentity !== null && nextIdentity !== null && grant.statIdentity !== nextIdentity) {
    throw new Error('terminal_file_grant_stale')
  }
}

function assertTerminalArtifactNotHardLinked(stats: RuntimeFileStatLike): void {
  if (isTerminalArtifactHardLinked(stats)) {
    throw new Error('terminal_file_grant_stale')
  }
}

function isTerminalArtifactHardLinked(stats: RuntimeFileStatLike): boolean {
  return typeof stats.nlink === 'number' && stats.nlink > 1
}

function truncateMobileFilePreview(content: string): {
  content: string
  truncated: boolean
  byteLength: number
} {
  const buffer = Buffer.from(content, 'utf8')
  if (buffer.byteLength <= MOBILE_FILE_READ_MAX_BYTES) {
    return { content, truncated: false, byteLength: buffer.byteLength }
  }
  return {
    content: buffer.subarray(0, MOBILE_FILE_READ_MAX_BYTES).toString('utf8'),
    truncated: true,
    byteLength: buffer.byteLength
  }
}
