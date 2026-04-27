import {
  readdir,
  readFile,
  writeFile,
  stat,
  lstat,
  mkdir,
  rename,
  cp,
  rm,
  realpath
} from 'fs/promises'
import { extname } from 'path'
import { execFile } from 'child_process'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import type { RelayContext } from './context'
import { expandTilde } from './context'
import {
  MAX_FILE_SIZE,
  MAX_PREVIEWABLE_BINARY_SIZE,
  DEFAULT_MAX_RESULTS,
  IMAGE_MIME_TYPES,
  isBinaryBuffer,
  searchWithRg,
  listFilesWithRg,
  checkRgAvailable
} from './fs-handler-utils'
import { listFilesWithGit, searchWithGitGrep } from './fs-handler-git-fallback'
import { listFilesWithReaddir } from './fs-handler-readdir-fallback'
import { buildExcludePathPrefixes } from '../shared/quick-open-filter'
import { buildInstallRgMessage } from './fs-handler-install-rg'

type WatchState = {
  rootPath: string
  unwatchFn: (() => void) | null
  setupPromise: Promise<void> | null
  isStale: () => boolean
}

export class FsHandler {
  private dispatcher: RelayDispatcher
  private context: RelayContext
  private watches = new Map<string, WatchState>()

  constructor(dispatcher: RelayDispatcher, context: RelayContext) {
    this.dispatcher = dispatcher
    this.context = context
    this.registerHandlers()
  }

  private registerHandlers(): void {
    this.dispatcher.onRequest('fs.readDir', (p) => this.readDir(p))
    this.dispatcher.onRequest('fs.readFile', (p) => this.readFile(p))
    this.dispatcher.onRequest('fs.writeFile', (p) => this.writeFile(p))
    this.dispatcher.onRequest('fs.stat', (p) => this.stat(p))
    this.dispatcher.onRequest('fs.deletePath', (p) => this.deletePath(p))
    this.dispatcher.onRequest('fs.createFile', (p) => this.createFile(p))
    this.dispatcher.onRequest('fs.createDir', (p) => this.createDir(p))
    this.dispatcher.onRequest('fs.rename', (p) => this.rename(p))
    this.dispatcher.onRequest('fs.copy', (p) => this.copy(p))
    this.dispatcher.onRequest('fs.realpath', (p) => this.realpath(p))
    this.dispatcher.onRequest('fs.search', (p) => this.search(p))
    this.dispatcher.onRequest('fs.listFiles', (p) => this.listFiles(p))
    this.dispatcher.onRequest('fs.watch', (p, context) => this.watch(p, context))
    this.dispatcher.onNotification('fs.unwatch', (p) => this.unwatch(p))
  }

  private async readDir(params: Record<string, unknown>) {
    const dirPath = expandTilde(params.dirPath as string)
    await this.context.validatePathResolved(dirPath)
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

  private async readFile(params: Record<string, unknown>) {
    const filePath = expandTilde(params.filePath as string)
    await this.context.validatePathResolved(filePath)
    const stats = await stat(filePath)
    const mimeType = IMAGE_MIME_TYPES[extname(filePath).toLowerCase()]
    const sizeLimit = mimeType ? MAX_PREVIEWABLE_BINARY_SIZE : MAX_FILE_SIZE
    if (stats.size > sizeLimit) {
      throw new Error(
        `File too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB exceeds ${sizeLimit / 1024 / 1024}MB limit`
      )
    }

    const buffer = await readFile(filePath)
    if (mimeType) {
      return { content: buffer.toString('base64'), isBinary: true, isImage: true, mimeType }
    }
    if (isBinaryBuffer(buffer)) {
      return { content: '', isBinary: true }
    }
    return { content: buffer.toString('utf-8'), isBinary: false }
  }

  private async writeFile(params: Record<string, unknown>) {
    const filePath = expandTilde(params.filePath as string)
    await this.context.validatePathResolved(filePath)
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
    await this.context.validatePathResolved(filePath)
    // Why: lstat is used instead of stat so that symlinks are reported as
    // symlinks rather than being silently followed. stat() follows symlinks,
    // meaning isSymbolicLink() would always return false.
    const stats = await lstat(filePath)
    let type: 'file' | 'directory' | 'symlink' = 'file'
    if (stats.isDirectory()) {
      type = 'directory'
    } else if (stats.isSymbolicLink()) {
      type = 'symlink'
    }
    return { size: stats.size, type, mtime: stats.mtimeMs }
  }

  private async deletePath(params: Record<string, unknown>) {
    const targetPath = expandTilde(params.targetPath as string)
    await this.context.validatePathResolved(targetPath)
    const recursive = params.recursive as boolean | undefined
    const stats = await stat(targetPath)
    if (stats.isDirectory() && !recursive) {
      throw new Error('Cannot delete directory without recursive flag')
    }
    await rm(targetPath, { recursive: !!recursive, force: true })
  }

  private async createFile(params: Record<string, unknown>) {
    const filePath = expandTilde(params.filePath as string)
    // Why: symlinks in parent directories can redirect creation outside the
    // workspace. validatePathResolved follows symlinks before checking roots.
    await this.context.validatePathResolved(filePath)
    const { dirname } = await import('path')
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, '', { encoding: 'utf-8', flag: 'wx' })
  }

  private async createDir(params: Record<string, unknown>) {
    const dirPath = expandTilde(params.dirPath as string)
    await this.context.validatePathResolved(dirPath)
    await mkdir(dirPath, { recursive: true })
  }

  private async rename(params: Record<string, unknown>) {
    const oldPath = expandTilde(params.oldPath as string)
    const newPath = expandTilde(params.newPath as string)
    await this.context.validatePathResolved(oldPath)
    await this.context.validatePathResolved(newPath)
    await rename(oldPath, newPath)
  }

  private async copy(params: Record<string, unknown>) {
    const source = expandTilde(params.source as string)
    const destination = expandTilde(params.destination as string)
    // Why: cp follows symlinks — a symlink inside the workspace pointing to
    // /etc would copy sensitive files into the workspace where readFile can
    // exfiltrate them.
    await this.context.validatePathResolved(source)
    await this.context.validatePathResolved(destination)
    await cp(source, destination, { recursive: true })
  }

  private async realpath(params: Record<string, unknown>) {
    const filePath = expandTilde(params.filePath as string)
    this.context.validatePath(filePath)
    const resolved = await realpath(filePath)
    // Why: a symlink inside the workspace may resolve to a path outside it.
    // Returning the resolved path without validation leaks the external target.
    this.context.validatePath(resolved)
    return resolved
  }

  private async search(params: Record<string, unknown>) {
    const query = params.query as string
    const rootPath = expandTilde(params.rootPath as string)
    // Why: a symlink inside the workspace pointing to a directory outside it
    // would let rg search (and return content from) files beyond the workspace.
    await this.context.validatePathResolved(rootPath)
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
    await this.context.validatePathResolved(rootPath)
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

  private async watch(params: Record<string, unknown>, context?: RequestContext) {
    const rootPath = expandTilde(params.rootPath as string)
    this.context.validatePath(rootPath)

    if (this.watches.size >= 20) {
      throw new Error('Maximum number of file watchers reached')
    }

    const existing = this.watches.get(rootPath)
    if (existing && !existing.isStale()) {
      if (existing.setupPromise) {
        await existing.setupPromise
      }
      return
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
  }
}
