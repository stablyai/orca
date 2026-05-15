/* eslint-disable max-lines -- Why: relay filesystem request handling shares
   path expansion, file IO, search, streaming reads, Space scans, and watch lifecycle state. */
import { readdir, writeFile, stat, lstat, mkdir, rename, cp, rm, realpath } from 'fs/promises'
import { execFile } from 'child_process'
import { join } from 'path'
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
import { buildExcludePathPrefixes } from '../shared/quick-open-filter'
import { buildInstallRgMessage } from './fs-handler-install-rg'
import { readRelayFileContent, readRelayFileStreamMetadata } from './fs-handler-file-read'
import { RelayStreamRegistry } from './fs-stream-registry'
import { scanWorkspaceSpaceDirectory } from './workspace-space-scan'

type WatchState = {
  rootPath: string
  unwatchFn: (() => void) | null
  setupPromise: Promise<void> | null
  isStale: () => boolean
}

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

export class FsHandler {
  private dispatcher: RelayDispatcher
  private watches = new Map<string, WatchState>()
  private streamRegistry = new RelayStreamRegistry()

  constructor(dispatcher: RelayDispatcher, _context: RelayContext) {
    this.dispatcher = dispatcher
    this.registerHandlers()
  }

  private registerHandlers(): void {
    this.dispatcher.onRequest('fs.readDir', (p) => this.readDir(p))
    this.dispatcher.onRequest('fs.readFile', (p) => this.readFile(p))
    this.dispatcher.onRequest('fs.readFileStream', (p, c) => this.readFileStream(p, c))
    this.dispatcher.onRequest('fs.writeFile', (p) => this.writeFile(p))
    this.dispatcher.onRequest('fs.stat', (p) => this.stat(p))
    this.dispatcher.onRequest('fs.deletePath', (p) => this.deletePath(p))
    this.dispatcher.onRequest('fs.createFile', (p) => this.createFile(p))
    this.dispatcher.onRequest('fs.createDir', (p) => this.createDir(p))
    this.dispatcher.onRequest('fs.createDirNoClobber', (p) => this.createDirNoClobber(p))
    this.dispatcher.onRequest('fs.rename', (p) => this.rename(p))
    this.dispatcher.onRequest('fs.copy', (p) => this.copy(p))
    this.dispatcher.onRequest('fs.realpath', (p) => this.realpath(p))
    this.dispatcher.onRequest('fs.search', (p) => this.search(p))
    this.dispatcher.onRequest('fs.listFiles', (p) => this.listFiles(p))
    this.dispatcher.onRequest('fs.workspaceSpaceScan', (p, c) => this.workspaceSpaceScan(p, c))
    this.dispatcher.onRequest('fs.watch', (p, context) => this.watch(p, context))
    this.dispatcher.onNotification('fs.unwatch', (p) => this.unwatch(p))
    this.dispatcher.onNotification('fs.cancelStream', (p) => this.cancelStream(p))
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

  private async readFileStream(
    params: Record<string, unknown>,
    context?: { isStale: () => boolean }
  ) {
    const filePath = expandTilde(params.filePath as string)
    const ctx = context ?? { isStale: () => false }
    return readRelayFileStreamMetadata(filePath, this.dispatcher, this.streamRegistry, ctx)
  }

  private cancelStream(params: Record<string, unknown>): void {
    const streamId = params.streamId as number | undefined
    if (typeof streamId === 'number') {
      this.streamRegistry.abort(streamId)
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
          mtime: targetStats.mtimeMs
        }
      } catch {
        return { size: stats.size, type: 'symlink', mtime: stats.mtimeMs }
      }
    }
    let type: 'file' | 'directory' | 'symlink' = 'file'
    if (stats.isDirectory()) {
      type = 'directory'
    }
    return { size: stats.size, type, mtime: stats.mtimeMs }
  }

  private async deletePath(params: Record<string, unknown>) {
    const targetPath = expandTilde(params.targetPath as string)
    const recursive = params.recursive as boolean | undefined
    const stats = await stat(targetPath)
    if (stats.isDirectory() && !recursive) {
      throw new Error('Cannot delete directory without recursive flag')
    }
    await rm(targetPath, { recursive: !!recursive, force: true })
  }

  private async createFile(params: Record<string, unknown>) {
    const filePath = expandTilde(params.filePath as string)
    const { dirname } = await import('path')
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

  private async listFiles(params: Record<string, unknown>): Promise<string[]> {
    const rootPath = expandTilde(params.rootPath as string)
    // Why: the main-to-relay RPC adds excludePaths so nested linked worktrees
    // don't get double-scanned. The shared helper validates the shape and
    // normalizes into root-relative prefixes; malformed input yields [] so
    // the request still succeeds (older apps omit the field entirely).
    const excludePathPrefixes = buildExcludePathPrefixes(rootPath, params.excludePaths)
    const rgAvailable = await checkRgAvailable()
    if (rgAvailable) {
      return listFilesWithRg(rootPath, excludePathPrefixes)
    }
    // Why: git ls-files only works inside git repos. Use rev-parse to detect
    // git ancestry — unlike checking for a local .git entry, this works from
    // subdirectories of a checkout (e.g. /repo/packages/app added as a folder).
    // Without this, a git subdirectory would fall through to readdir and
    // surface .gitignore'd build artifacts.
    const isGitRepo = await new Promise<boolean>((resolve) => {
      execFile('git', ['rev-parse', '--is-inside-work-tree'], { cwd: rootPath }, (err) =>
        resolve(!err)
      )
    })
    if (isGitRepo) {
      return listFilesWithGit(rootPath, excludePathPrefixes)
    }
    // Why: the readdir walker rejects on cap/deadline instead of returning a
    // partial list (design doc: silent truncation is worse than an explicit
    // error). On a home-root without rg that's almost always an install-rg
    // problem, so translate the opaque cap error into actionable guidance
    // the user can act on directly from the error toast.
    try {
      return await listFilesWithReaddir(rootPath, excludePathPrefixes)
    } catch (err) {
      throw new Error(await buildInstallRgMessage(err))
    }
  }

  private async workspaceSpaceScan(params: Record<string, unknown>, context: RequestContext) {
    const rootPath = expandTilde(params.rootPath as string)
    return scanWorkspaceSpaceDirectory(rootPath, context)
  }

  private async watch(params: Record<string, unknown>, context?: RequestContext) {
    const rootPath = expandTilde(params.rootPath as string)

    const existing = this.watches.get(rootPath)
    if (existing && !existing.isStale()) {
      if (existing.setupPromise) {
        await existing.setupPromise
      }
      return
    }
    if (existing?.isStale()) {
      existing.unwatchFn?.()
      this.watches.delete(rootPath)
    }

    if (this.watches.size >= 20) {
      throw new Error('Maximum number of file watchers reached')
    }

    const watchState: WatchState = {
      rootPath,
      unwatchFn: null,
      setupPromise: null,
      isStale: () => context?.isStale() ?? false
    }
    this.watches.set(rootPath, watchState)

    const setupPromise = (async () => {
      const watcher = await import('@parcel/watcher')
      const subscription = await watcher.subscribe(
        rootPath,
        (err, events) => {
          if (err) {
            this.dispatcher.notify('fs.changed', {
              events: [{ kind: 'overflow', absolutePath: rootPath }]
            })
            return
          }
          const mapped = events.map((evt) => ({
            kind: evt.type,
            absolutePath: evt.path
          }))
          this.dispatcher.notify('fs.changed', { events: mapped })
        },
        { ignore: ['.git', 'node_modules', 'dist', 'build', '.next', '.cache', '__pycache__'] }
      )
      watchState.unwatchFn = () => {
        void subscription.unsubscribe()
      }
      if (watchState.isStale() || this.watches.get(rootPath) !== watchState) {
        // Why: if the client reconnects while watcher setup is in flight, the
        // response is discarded and no client can later balance it with
        // fs.unwatch. Tear down only this request's subscription so a newer
        // replacement watch for the same root is not removed.
        void subscription.unsubscribe()
        if (this.watches.get(rootPath) === watchState) {
          this.watches.delete(rootPath)
        }
      }
    })()
    watchState.setupPromise = setupPromise

    try {
      await setupPromise
    } catch {
      if (this.watches.get(rootPath) === watchState) {
        this.watches.delete(rootPath)
      }
      // @parcel/watcher not available -- polling fallback would go here
      process.stderr.write('[relay] File watcher not available, fs.changed events disabled\n')
    }
  }

  private unwatch(params: Record<string, unknown>): void {
    const rootPath = expandTilde(params.rootPath as string)
    const state = this.watches.get(rootPath)
    if (state) {
      state.unwatchFn?.()
      this.watches.delete(rootPath)
    }
  }

  dispose(): void {
    for (const [, state] of this.watches) {
      state.unwatchFn?.()
    }
    this.watches.clear()
    void this.streamRegistry.disposeAll()
  }
}
