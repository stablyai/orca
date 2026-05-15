/* eslint-disable max-lines -- Why: filesystem, editor-file, and search commands share the same local/SSH path authorization rules. Keeping that IO adapter together prevents separate command paths from drifting on safety checks. */
import type { ChildProcess } from 'child_process'
import { watch as watchFs } from 'fs'
import {
  constants,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from 'fs/promises'
import { basename, dirname, extname, join } from 'path'
import type {
  DirEntry,
  FsChangeEvent,
  GitWorktreeInfo,
  MarkdownDocument,
  SearchOptions,
  SearchResult,
  Worktree
} from '../../shared/types'
import type {
  RuntimeFileListResult,
  RuntimeFileOpenResult,
  RuntimeFilePreviewResult,
  RuntimeFileReadResult
} from '../../shared/runtime-types'
import { wslAwareSpawn } from '../git/runner'
import { parseWslPath, toWindowsWslPath } from '../wsl'
import { isENOENT, resolveAuthorizedPath } from '../ipc/filesystem-auth'
import { listQuickOpenFiles } from '../ipc/filesystem-list-files'
import { searchWithGitGrep } from '../ipc/filesystem-search-git'
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
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { joinWorktreeRelativePath, normalizeRuntimeRelativePath } from './runtime-relative-paths'

const MOBILE_FILE_LIST_LIMIT = 5000
const MOBILE_FILE_READ_MAX_BYTES = 512 * 1024
const RUNTIME_PREVIEWABLE_BINARY_MAX_BYTES = 10 * 1024 * 1024
const WINDOWS_RUNTIME_FILE_WATCH_DEBOUNCE_MS = 150
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

export type ResolvedRuntimeFileWorktree = Worktree & { git: GitWorktreeInfo }

export type RuntimeFileCommandHost = {
  getRuntimeId(): string
  requireStore(): Store
  resolveWorktreeSelector(selector: string): Promise<ResolvedRuntimeFileWorktree>
  resolveRuntimeGitTarget(
    selector: string
  ): Promise<{ worktree: ResolvedRuntimeFileWorktree; connectionId?: string }>
  openFile(worktreeId: string, filePath: string, relativePath: string): void
}

export class RuntimeFileCommands {
  private activeRuntimeTextSearches = new Map<string, ChildProcess>()

  constructor(private readonly host: RuntimeFileCommandHost) {}

  async listMobileFiles(worktreeSelector: string): Promise<RuntimeFileListResult> {
    const store = this.host.requireStore()
    const worktree = await this.host.resolveWorktreeSelector(worktreeSelector)
    const repo = store.getRepo(worktree.repoId)
    const connectionId = repo?.connectionId ?? undefined
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

  async openMobileFile(
    worktreeSelector: string,
    relativePath: string
  ): Promise<RuntimeFileOpenResult> {
    const worktree = await this.host.resolveWorktreeSelector(worktreeSelector)
    if (!isSafeMobileRelativePath(relativePath)) {
      throw new Error('invalid_relative_path')
    }
    const kind = isMobileBinaryPath(relativePath)
      ? 'binary'
      : isMobileMarkdownPath(relativePath)
        ? 'markdown'
        : 'text'
    if (kind === 'binary') {
      return { worktree: worktree.id, relativePath, kind, opened: false }
    }
    const filePath = joinWorktreeRelativePath(worktree.path, relativePath)
    this.host.openFile(worktree.id, filePath, relativePath)
    return { worktree: worktree.id, relativePath, kind, opened: true }
  }

  async readMobileFile(
    worktreeSelector: string,
    relativePath: string
  ): Promise<RuntimeFileReadResult> {
    const store = this.host.requireStore()
    const worktree = await this.host.resolveWorktreeSelector(worktreeSelector)
    if (!isSafeMobileRelativePath(relativePath)) {
      throw new Error('invalid_relative_path')
    }
    if (isMobileBinaryPath(relativePath)) {
      throw new Error('binary_file')
    }

    const repo = store.getRepo(worktree.repoId)
    const filePath = joinWorktreeRelativePath(worktree.path, relativePath)
    const content = repo?.connectionId
      ? await this.readRemoteMobileFile(filePath, repo.connectionId)
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

  async readFileExplorerDir(worktreeSelector: string, relativePath: string): Promise<DirEntry[]> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_filesystem_unavailable')
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
          isDirectory: await isRuntimeDirectoryEntry(entryPath),
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
    callback: (events: FsChangeEvent[]) => void
  ): Promise<() => void> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, '')
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_filesystem_unavailable')
      }
      return provider.watch(target.path, callback)
    }

    const rootPath = await resolveAuthorizedPath(target.path, this.host.requireStore())
    const rootStats = await stat(rootPath)
    if (!rootStats.isDirectory()) {
      throw new Error('not_a_directory')
    }
    if (process.platform === 'win32') {
      return watchWindowsRuntimeFileExplorer(rootPath, callback)
    }
    const watcher = await import('@parcel/watcher')
    const subscription = await watcher.subscribe(
      rootPath,
      (err, events) => {
        if (err) {
          console.error('[runtime-files.watch] watcher error', { rootPath, err })
          callback([{ kind: 'overflow', absolutePath: rootPath }])
          return
        }
        void Promise.all(
          events.map(async (event): Promise<FsChangeEvent> => {
            let isDirectory = false
            try {
              isDirectory = (await stat(event.path)).isDirectory()
            } catch {
              isDirectory = false
            }
            return {
              kind: event.type,
              absolutePath: event.path,
              isDirectory
            }
          })
        ).then(callback)
      },
      {
        ignore: [
          '.git',
          'node_modules',
          'dist',
          'build',
          '.next',
          '.cache',
          '__pycache__',
          'target',
          '.venv'
        ]
      }
    )
    return () => {
      void subscription.unsubscribe().catch((err: unknown) => {
        console.error('[runtime-files.watch] unsubscribe error', { rootPath, err })
      })
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
        throw new Error('remote_filesystem_unavailable')
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

  async writeFileExplorerFile(
    worktreeSelector: string,
    relativePath: string,
    content: string
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_filesystem_unavailable')
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
    contentBase64: string
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    const content = Buffer.from(contentBase64, 'base64')
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_filesystem_unavailable')
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
    append: boolean
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    const content = Buffer.from(contentBase64, 'base64')
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_filesystem_unavailable')
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
    relativePath: string
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_filesystem_unavailable')
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
    relativePath: string
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_filesystem_unavailable')
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
    relativePath: string
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_filesystem_unavailable')
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
    finalRelativePath: string
  ): Promise<{ ok: true }> {
    const tempTarget = await this.resolveFileExplorerPath(worktreeSelector, tempRelativePath)
    const finalTarget = await this.resolveFileExplorerPath(worktreeSelector, finalRelativePath)
    const provider = tempTarget.connectionId
      ? getSshFilesystemProvider(tempTarget.connectionId)
      : null
    if (tempTarget.connectionId) {
      if (!provider) {
        throw new Error('remote_filesystem_unavailable')
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
    newRelativePath: string
  ): Promise<{ ok: true }> {
    const oldTarget = await this.resolveFileExplorerPath(worktreeSelector, oldRelativePath)
    const newTarget = await this.resolveFileExplorerPath(worktreeSelector, newRelativePath)
    const provider = oldTarget.connectionId
      ? getSshFilesystemProvider(oldTarget.connectionId)
      : null
    if (oldTarget.connectionId) {
      if (!provider) {
        throw new Error('remote_filesystem_unavailable')
      }
      await provider.rename(oldTarget.path, newTarget.path)
      return { ok: true }
    }

    const store = this.host.requireStore()
    const oldPath = await resolveAuthorizedPath(oldTarget.path, store, { preserveSymlink: true })
    const newPath = await resolveAuthorizedPath(newTarget.path, store, { preserveSymlink: true })
    await assertRuntimePathDoesNotExist(newPath)
    await rename(oldPath, newPath)
    return { ok: true }
  }

  async copyFileExplorerPath(
    worktreeSelector: string,
    sourceRelativePath: string,
    destinationRelativePath: string
  ): Promise<{ ok: true }> {
    const sourceTarget = await this.resolveFileExplorerPath(worktreeSelector, sourceRelativePath)
    const destinationTarget = await this.resolveFileExplorerPath(
      worktreeSelector,
      destinationRelativePath
    )
    const provider = sourceTarget.connectionId
      ? getSshFilesystemProvider(sourceTarget.connectionId)
      : null
    if (sourceTarget.connectionId) {
      if (!provider) {
        throw new Error('remote_filesystem_unavailable')
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
    // Why: duplicate/copy operations are deconflicted by the caller. COPYFILE_EXCL
    // preserves the same no-clobber invariant as the local shell copy IPC.
    await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL)
    return { ok: true }
  }

  async deleteFileExplorerPath(
    worktreeSelector: string,
    relativePath: string,
    recursive?: boolean
  ): Promise<{ ok: true }> {
    const target = await this.resolveFileExplorerPath(worktreeSelector, relativePath)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_filesystem_unavailable')
      }
      await provider.deletePath(target.path, recursive)
      return { ok: true }
    }

    const targetPath = await resolveAuthorizedPath(target.path, this.host.requireStore(), {
      preserveSymlink: true
    })
    // Why: a non-local runtime has no client OS Trash/Recycling Bin; server-side
    // file mutations are permanent and the renderer confirms before calling this.
    await rm(targetPath, { recursive: recursive === true, force: true })
    return { ok: true }
  }

  async searchRuntimeFiles(
    worktreeSelector: string,
    options: Omit<SearchOptions, 'rootPath'>
  ): Promise<SearchResult> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    const rootPath = target.worktree.path
    const searchOptions = { ...options, rootPath }
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_filesystem_unavailable')
      }
      return provider.search(searchOptions)
    }
    return this.searchLocalRuntimeFiles(rootPath, searchOptions)
  }

  async listRuntimeFiles(
    worktreeSelector: string,
    options: { excludePaths?: string[] } = {}
  ): Promise<string[]> {
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
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
    const target = await this.host.resolveRuntimeGitTarget(worktreeSelector)
    const provider = target.connectionId ? getSshFilesystemProvider(target.connectionId) : null
    if (target.connectionId) {
      if (!provider) {
        throw new Error('remote_filesystem_unavailable')
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
        throw new Error('remote_filesystem_unavailable')
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
    const authorizedRootPath = await resolveAuthorizedPath(rootPath, this.host.requireStore())
    const maxResults = Math.max(
      1,
      Math.min(options.maxResults ?? DEFAULT_SEARCH_MAX_RESULTS, DEFAULT_SEARCH_MAX_RESULTS)
    )
    const rgAvailable = await checkRgAvailable(authorizedRootPath)
    if (!rgAvailable) {
      return searchWithGitGrep(authorizedRootPath, options, maxResults)
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
        clearTimeout(killTimeout)
        resolvePromise(finalize(acc))
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
        stdio: ['ignore', 'pipe', 'pipe']
      })
      child = nextChild
      this.activeRuntimeTextSearches.set(searchKey, nextChild)

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
      nextChild.once('error', () => resolveOnce())
      nextChild.once('close', () => {
        if (stdoutBuffer) {
          processLine(stdoutBuffer)
        }
        resolveOnce()
      })

      const killTimeout = setTimeout(() => {
        acc.truncated = true
        child?.kill()
      }, SEARCH_TIMEOUT_MS)
    })
  }

  private async resolveFileExplorerPath(
    worktreeSelector: string,
    relativePath: string
  ): Promise<{ worktree: ResolvedRuntimeFileWorktree; path: string; connectionId?: string }> {
    const store = this.host.requireStore()
    const worktree = await this.host.resolveWorktreeSelector(worktreeSelector)
    const normalizedRelativePath = normalizeRuntimeRelativePath(relativePath)
    const repo = store.getRepo(worktree.repoId)
    return {
      worktree,
      path: joinWorktreeRelativePath(worktree.path, normalizedRelativePath),
      connectionId: repo?.connectionId ?? undefined
    }
  }

  private async listRemoteMobileFiles(rootPath: string, connectionId: string): Promise<string[]> {
    const provider = getSshFilesystemProvider(connectionId)
    if (!provider) {
      return []
    }
    return provider.listFiles(rootPath)
  }

  private async readRemoteMobileFile(filePath: string, connectionId: string): Promise<string> {
    const provider = getSshFilesystemProvider(connectionId)
    if (!provider) {
      throw new Error('remote_filesystem_unavailable')
    }
    const fileStat = await provider.stat(filePath)
    // Why: the SSH filesystem API does not expose ranged reads here, so reject
    // oversized remote previews instead of streaming a large file just to trim it.
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
  callback: (events: FsChangeEvent[]) => void
): () => void {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null

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

  // Why: Parcel probes Watchman before the Windows backend and its native
  // watcher can abort the headless server process. For remote Windows runtimes,
  // a conservative overflow refresh is safer than a process-wide native crash.
  const watcher = watchFs(rootPath, { recursive: true }, scheduleOverflow)
  watcher.on('error', (err) => {
    console.error('[runtime-files.watch] Windows watcher error', { rootPath, err })
    scheduleOverflow()
  })

  return () => {
    disposed = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    try {
      watcher.close()
    } catch (err) {
      console.error('[runtime-files.watch] Windows watcher close error', { rootPath, err })
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

async function isRuntimeDirectoryEntry(entryPath: string): Promise<boolean> {
  try {
    return (await stat(entryPath)).isDirectory()
  } catch {
    return false
  }
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
  // Why: mobile file previews are read-only convenience views; cap the read so
  // opening a generated log or bundle cannot block the WebSocket like oversized scrollback.
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
