/* eslint-disable max-lines -- Why: relay filesystem request handling shares
   path expansion, file IO, search, streaming reads, and Space scans. */
import { readdir, writeFile, stat, lstat, mkdir, rename, cp, rm, realpath } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import type { RelayContext } from './context'
// Why: RelayContext is accepted in the constructor for protocol back-compat
// (see docs/relay-fs-allowlist-removal.md), but no longer consulted on FS ops.
import { expandTilde } from './context'
import {
  DEFAULT_MAX_RESULTS,
  searchWithRg,
  listFilesWithRg,
  checkRgAvailable
} from './fs-handler-utils'
import { listFilesWithGit, searchWithGitGrep } from './fs-handler-git-fallback'
import { listFilesWithReaddir } from './fs-handler-readdir-fallback'
import { ListFilesScanCoordinator } from './fs-list-files-scan-coordinator'
import {
  isFileListingCancellation,
  throwIfFileListingCancelled
} from '../shared/file-listing-cancellation'
import { isQuickOpenReaddirBudgetError } from '../shared/quick-open-readdir-walk'
import { buildExcludePathPrefixes } from '../shared/quick-open-filter'
import { buildInstallRgMessage } from './fs-handler-install-rg'
import { readRelayFileContent, readRelayFileStreamMetadata } from './fs-handler-file-read'
import {
  readVerifiedTerminalArtifact,
  writeVerifiedTerminalArtifact
} from './fs-handler-terminal-artifact'
import { RelayStreamRegistry } from './fs-stream-registry'
import { scanWorkspaceSpaceDirectory } from './workspace-space-scan'
import { buildRelayCommandEnv } from './relay-command-env'
import { assertNoClobberRenameDestinationAvailable } from '../shared/filesystem-rename-collision'
import { RelayFilesystemWatchRegistry } from './relay-filesystem-watch-registry'
import type { RelayWatcherProcessPool } from './relay-watcher-process-pool'

async function isDirectoryEntry(
  dirPath: string,
  entry: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }
): Promise<boolean> {
  if (entry.isDirectory()) {
    return true
  }
  if (!entry.isSymbolicLink()) {
    return false
  }
  try {
    // Why: the file explorer needs target type for symlinked directories so a
    // workspace link to an external folder expands instead of opening as a file.
    return (await stat(join(dirPath, entry.name))).isDirectory()
  } catch {
    return false
  }
}

function fileStatFromLstat(stats: Awaited<ReturnType<typeof lstat>>) {
  let type: 'file' | 'directory' | 'symlink' = 'file'
  if (stats.isDirectory()) {
    type = 'directory'
  } else if (stats.isSymbolicLink()) {
    type = 'symlink'
  }
  return {
    size: stats.size,
    type,
    mtime: stats.mtimeMs,
    mtimeMs: stats.mtimeMs,
    dev: stats.dev,
    ino: stats.ino,
    nlink: stats.nlink
  }
}

export class FsHandler {
  private dispatcher: RelayDispatcher
  private watchRegistry: RelayFilesystemWatchRegistry
  private streamRegistry = new RelayStreamRegistry()
  private listFilesScans = new ListFilesScanCoordinator()

  constructor(
    dispatcher: RelayDispatcher,
    _context: RelayContext,
    watcherPool?: RelayWatcherProcessPool
  ) {
    this.dispatcher = dispatcher
    this.watchRegistry = new RelayFilesystemWatchRegistry(dispatcher, watcherPool)
    this.registerHandlers()
    this.dispatcher.onClientDetached?.(() => {
      // Why: a detached client's fs.streamAck frames will never arrive; wake
      // any pump parked on the ack window so it re-checks staleness and exits
      // instead of stranding its open file handle.
      this.streamRegistry.wakeAllAckWaiters()
    })
  }

  getWatchRegistry(): RelayFilesystemWatchRegistry {
    return this.watchRegistry
  }

  private registerHandlers(): void {
    this.dispatcher.onRequest('fs.readDir', (p) => this.readDir(p))
    this.dispatcher.onRequest('fs.readFile', (p) => this.readFile(p))
    this.dispatcher.onRequest('fs.readFileStream', (p, c) => this.readFileStream(p, c))
    this.dispatcher.onRequest('fs.readTerminalArtifact', (p) => this.readTerminalArtifact(p))
    this.dispatcher.onRequest('fs.tempDir', () => this.tempDir())
    this.dispatcher.onRequest('fs.writeFile', (p) => this.writeFile(p))
    this.dispatcher.onRequest('fs.writeTerminalArtifact', (p) => this.writeTerminalArtifact(p))
    this.dispatcher.onRequest('fs.stat', (p) => this.stat(p))
    this.dispatcher.onRequest('fs.lstat', (p) => this.lstat(p))
    this.dispatcher.onRequest('fs.deletePath', (p) => this.deletePath(p))
    this.dispatcher.onRequest('fs.createFile', (p) => this.createFile(p))
    this.dispatcher.onRequest('fs.createDir', (p) => this.createDir(p))
    this.dispatcher.onRequest('fs.createDirNoClobber', (p) => this.createDirNoClobber(p))
    this.dispatcher.onRequest('fs.rename', (p) => this.rename(p))
    this.dispatcher.onRequest('fs.renameNoClobber', (p) => this.renameNoClobber(p))
    this.dispatcher.onRequest('fs.copy', (p) => this.copy(p))
    this.dispatcher.onRequest('fs.realpath', (p) => this.realpath(p))
    this.dispatcher.onRequest('fs.search', (p) => this.search(p))
    this.dispatcher.onRequest('fs.listFiles', (p, c) => this.listFiles(p, c))
    this.dispatcher.onRequest('fs.workspaceSpaceScan', (p, c) => this.workspaceSpaceScan(p, c))
    this.dispatcher.onRequest('fs.watch', (p, context) =>
      this.watchRegistry.watch(
        expandTilde(p.rootPath as string),
        context,
        typeof p.watchId === 'number' && Number.isSafeInteger(p.watchId) ? p.watchId : undefined
      )
    )
    this.dispatcher.onRequest('fs.unwatchAndWait', (p, context) =>
      this.watchRegistry.unwatchAndWait(expandTilde(p.rootPath as string), context)
    )
    this.dispatcher.onNotification('fs.unwatch', (p, context) =>
      this.watchRegistry.unwatch(expandTilde(p.rootPath as string), context)
    )
    this.dispatcher.onNotification('fs.cancelStream', (p) => this.cancelStream(p))
    this.dispatcher.onNotification('fs.streamAck', (p) => this.streamAck(p))
  }

  private async readDir(params: Record<string, unknown>) {
    const dirPath = expandTilde(params.dirPath as string)
    const entries = await readdir(dirPath, { withFileTypes: true })
    const mapped = await Promise.all(
      entries.map(async (entry) => ({
        name: entry.name,
        isDirectory: await isDirectoryEntry(dirPath, entry),
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

  private async readFile(params: Record<string, unknown>) {
    const filePath = expandTilde(params.filePath as string)
    return readRelayFileContent(filePath)
  }

  private async readTerminalArtifact(params: Record<string, unknown>) {
    return readVerifiedTerminalArtifact({
      ...params,
      filePath: expandTilde(params.filePath as string)
    })
  }

  private async readFileStream(params: Record<string, unknown>, context?: RequestContext) {
    const filePath = expandTilde(params.filePath as string)
    const ctx = context ?? { clientId: 0, isStale: () => false }
    return readRelayFileStreamMetadata(filePath, this.dispatcher, this.streamRegistry, ctx, {
      // Why: only target the requesting client when the dispatcher actually
      // routed this request (context present) — direct-call tests and legacy
      // paths keep broadcast semantics.
      ...(context ? { clientId: context.clientId } : {}),
      paceWithAcks: params.flowControl === 'ack'
    })
  }

  private async tempDir(): Promise<string> {
    return tmpdir()
  }

  private cancelStream(params: Record<string, unknown>): void {
    const streamId = params.streamId as number | undefined
    if (typeof streamId === 'number') {
      this.streamRegistry.abort(streamId)
    }
  }

  private streamAck(params: Record<string, unknown>): void {
    const streamId = params.streamId as number | undefined
    const seq = params.seq as number | undefined
    if (typeof streamId === 'number' && typeof seq === 'number') {
      this.streamRegistry.recordAck(streamId, seq)
    }
  }

  private async writeFile(params: Record<string, unknown>) {
    const filePath = expandTilde(params.filePath as string)
    const content = params.content as string
    try {
      const fileStats = await lstat(filePath)
      if (fileStats.isDirectory()) {
        throw new Error('Cannot write to a directory')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
    await writeFile(filePath, content, 'utf-8')
  }

  private async writeTerminalArtifact(params: Record<string, unknown>) {
    return writeVerifiedTerminalArtifact({
      ...params,
      filePath: expandTilde(params.filePath as string)
    })
  }

  private async stat(params: Record<string, unknown>) {
    const filePath = expandTilde(params.filePath as string)
    const stats = await lstat(filePath)
    if (stats.isSymbolicLink()) {
      try {
        // Why: callers use stat to decide whether to read a path or enumerate
        // it; symlink-to-directory must behave like its target for that choice.
        const targetStats = await stat(filePath)
        return {
          size: targetStats.size,
          type: targetStats.isDirectory() ? 'directory' : 'file',
          mtime: targetStats.mtimeMs,
          mtimeMs: targetStats.mtimeMs,
          dev: targetStats.dev,
          ino: targetStats.ino,
          nlink: targetStats.nlink
        }
      } catch {
        return { size: stats.size, type: 'symlink', mtime: stats.mtimeMs }
      }
    }
    return fileStatFromLstat(stats)
  }

  private async lstat(params: Record<string, unknown>) {
    const filePath = expandTilde(params.filePath as string)
    return fileStatFromLstat(await lstat(filePath))
  }

  private async deletePath(params: Record<string, unknown>) {
    const targetPath = expandTilde(params.targetPath as string)
    const recursive = params.recursive as boolean | undefined
    const stats = await stat(targetPath)
    if (stats.isDirectory() && !recursive) {
      throw new Error('Cannot delete directory without recursive flag')
    }
    const remove = () => rm(targetPath, { recursive: !!recursive, force: true })
    if (stats.isDirectory()) {
      // Why: forced orphan cleanup bypasses git.removeWorktree but must hold
      // the same relay-wide watcher fence through recursive deletion.
      await this.watchRegistry.runWithRemovalFence(targetPath, remove)
      return
    }
    await remove()
  }

  private async createFile(params: Record<string, unknown>) {
    const filePath = expandTilde(params.filePath as string)
    const { dirname } = await import('node:path')
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, '', { encoding: 'utf-8', flag: 'wx' })
  }

  private async createDir(params: Record<string, unknown>) {
    const dirPath = expandTilde(params.dirPath as string)
    await mkdir(dirPath, { recursive: true })
  }

  private async createDirNoClobber(params: Record<string, unknown>) {
    const dirPath = expandTilde(params.dirPath as string)
    await mkdir(dirPath, { recursive: false })
  }

  private async rename(params: Record<string, unknown>) {
    const oldPath = expandTilde(params.oldPath as string)
    const newPath = expandTilde(params.newPath as string)
    await rename(oldPath, newPath)
  }

  private async renameNoClobber(params: Record<string, unknown>) {
    const oldPath = expandTilde(params.oldPath as string)
    const newPath = expandTilde(params.newPath as string)
    // Why: user-facing file renames must not inherit fs.rename's overwrite
    // behavior; keep the guard inside the relay so SSH checks the remote FS.
    await assertNoClobberRenameDestinationAvailable(oldPath, newPath)
    await rename(oldPath, newPath)
  }

  private async copy(params: Record<string, unknown>) {
    const source = expandTilde(params.source as string)
    const destination = expandTilde(params.destination as string)
    try {
      await cp(source, destination, { recursive: true, force: false, errorOnExist: true })
    } catch (error) {
      const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
      if (code === 'EEXIST' || code === 'ERR_FS_CP_EEXIST') {
        throw new Error('EEXIST: destination already exists')
      }
      throw error
    }
  }

  private async realpath(params: Record<string, unknown>) {
    const filePath = expandTilde(params.filePath as string)
    return await realpath(filePath)
  }

  private async search(params: Record<string, unknown>) {
    const query = params.query as string
    const rootPath = expandTilde(params.rootPath as string)
    const caseSensitive = params.caseSensitive as boolean | undefined
    const wholeWord = params.wholeWord as boolean | undefined
    const useRegex = params.useRegex as boolean | undefined
    const includePattern = params.includePattern as string | undefined
    const excludePattern = params.excludePattern as string | undefined
    const maxResults = Math.min(
      (params.maxResults as number) || DEFAULT_MAX_RESULTS,
      DEFAULT_MAX_RESULTS
    )

    const rgAvailable = await checkRgAvailable()
    if (!rgAvailable) {
      return searchWithGitGrep(rootPath, query, {
        caseSensitive,
        wholeWord,
        useRegex,
        includePattern,
        excludePattern,
        maxResults
      })
    }

    return searchWithRg(rootPath, query, {
      caseSensitive,
      wholeWord,
      useRegex,
      includePattern,
      excludePattern,
      maxResults
    })
  }

  private listFiles(params: Record<string, unknown>, context?: RequestContext): Promise<string[]> {
    const rootPath = expandTilde(params.rootPath as string)
    const maxResults =
      typeof params.maxResults === 'number' &&
      Number.isInteger(params.maxResults) &&
      params.maxResults > 0
        ? Math.min(params.maxResults, 20_001)
        : undefined
    // Why: the main-to-relay RPC adds excludePaths so nested linked worktrees
    // don't get double-scanned. The shared helper validates the shape and
    // normalizes into root-relative prefixes; malformed input yields [] so
    // the request still succeeds (older apps omit the field entirely).
    const excludePathPrefixes = buildExcludePathPrefixes(rootPath, params.excludePaths)
    // Why #7721: full-tree scans are the relay's most expensive request; the
    // coordinator caps them at one per client, coalescing duplicates and
    // aborting a stale scan when the workspace changes or the host cancels.
    return this.listFilesScans.run({
      clientId: context?.clientId ?? 0,
      key: JSON.stringify([rootPath, excludePathPrefixes, maxResults]),
      signal: context?.signal,
      start: (signal) => this.runListFilesScan(rootPath, excludePathPrefixes, signal, maxResults)
    })
  }

  private async runListFilesScan(
    rootPath: string,
    excludePathPrefixes: string[],
    signal: AbortSignal,
    maxResults?: number
  ): Promise<string[]> {
    const rgAvailable = await checkRgAvailable()
    throwIfFileListingCancelled(signal)
    if (rgAvailable) {
      return listFilesWithRg(rootPath, excludePathPrefixes, { signal, maxResults })
    }
    // Why: git ls-files only works inside git repos. Use rev-parse to detect
    // git ancestry — unlike checking for a local .git entry, this works from
    // subdirectories of a checkout (e.g. /repo/packages/app added as a folder).
    // Without this, a git subdirectory would fall through to readdir and
    // surface .gitignore'd build artifacts.
    const isGitRepo = await new Promise<boolean>((resolve) => {
      execFile(
        'git',
        ['rev-parse', '--is-inside-work-tree'],
        { cwd: rootPath, env: buildRelayCommandEnv() },
        (err) => resolve(!err)
      )
    })
    if (isGitRepo) {
      // Why: a git monorepo parent fills nested-repo subtrees via the readdir
      // walk, which can exhaust the same cap/deadline. Translate only those
      // budget errors into install-rg guidance; genuine git failures keep
      // their own messages.
      try {
        return await listFilesWithGit(rootPath, excludePathPrefixes, { signal, maxResults })
      } catch (err) {
        if (isQuickOpenReaddirBudgetError(err)) {
          throw new Error(await buildInstallRgMessage(err))
        }
        throw err
      }
    }
    // Why: the readdir walker rejects on cap/deadline instead of returning a
    // partial list (design doc: silent truncation is worse than an explicit
    // error). On a home-root without rg that's almost always an install-rg
    // problem, so translate the opaque cap error into actionable guidance
    // the user can act on directly from the error toast.
    try {
      return await listFilesWithReaddir(rootPath, excludePathPrefixes, { signal, maxResults })
    } catch (err) {
      // Why: a cancelled scan is not an rg-availability problem; wrapping it
      // in install-rg guidance would surface bogus advice on the client.
      if (isFileListingCancellation(err)) {
        throw err
      }
      throw new Error(await buildInstallRgMessage(err))
    }
  }

  private async workspaceSpaceScan(params: Record<string, unknown>, context: RequestContext) {
    const rootPath = expandTilde(params.rootPath as string)
    return scanWorkspaceSpaceDirectory(rootPath, context)
  }

  dispose(): void {
    this.watchRegistry.dispose()
    void this.streamRegistry.disposeAll()
  }
}
