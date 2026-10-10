import { constants, copyFile, lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import type { ChildProcessHandle } from '@orca/process-host/process-spec'
import { readAuthorizedDocPreviewFile } from '../../shared/doc-preview-file-access'
import { renameLocalPathSerializedByDestination } from '../destination-serialized-local-rename'
import type { resolveAuthorizedPath as ResolveAuthorizedPath } from '../ipc/filesystem-auth'
import { isENOENT } from '../ipc/filesystem-path-containment'
import { assertNotExists, rethrowWithUserMessage } from '../ipc/filesystem-create-path-guards'
import { classifyFilesystemDirectoryEntries } from '../ipc/filesystem-symlink-directory-entries'
import { getLocalGitOptionsForRegisteredWorktree } from '../ipc/local-worktree-runtime-options'
import { listMarkdownDocuments } from '../ipc/markdown-documents'
import type { Store } from '../persistence'
import { runBundledRipgrepTextSearch } from '../ripgrep/bundled-ripgrep-text-search'
import { parseWslPath } from '../wsl'
import type { IFilesystemProvider } from './filesystem-provider-contract'

export type LocalFilesystemProviderOptions = {
  /** Read lazily so a call that fails earlier never touches the store. */
  requireStore(): Store
  /** Injected: the auth layer reaches the host router, so importing it here would be a cycle. */
  resolveAuthorizedPath: typeof ResolveAuthorizedPath
  /** Registers a running text search for cancellation; returns its release. */
  onTextSearchSpawn?: (child: ChildProcessHandle) => () => void
}

/**
 * Contract methods with a runtime-command local twin. Reads, listing and watching keep
 * their existing local call sites: their local limits and result shapes differ from the contract.
 */
export type LocalFilesystemProvider = Pick<
  IFilesystemProvider,
  | 'readDir'
  | 'readDocPreviewFile'
  | 'writeFile'
  | 'writeFileBase64'
  | 'writeFileBase64Chunk'
  | 'pathsExist'
  | 'stat'
  | 'deletePath'
  | 'createFile'
  | 'createDir'
  | 'createDirNoClobber'
  | 'renameNoClobber'
  | 'copy'
  | 'search'
  | 'listMarkdownDocuments'
>

/** This machine's file operations behind the store's path authorization; build one per call. */
export function createLocalFilesystemProvider(
  options: LocalFilesystemProviderOptions
): LocalFilesystemProvider {
  const { resolveAuthorizedPath } = options
  const authorize = (path: string) => resolveAuthorizedPath(path, options.requireStore())
  // Why: rename, copy and delete act on a symlink itself, never on what it points to.
  const authorizeLink = (path: string) =>
    resolveAuthorizedPath(path, options.requireStore(), { preserveSymlink: true })
  const writeBase64 = async (filePath: string, contentBase64: string, append: boolean) => {
    const content = Buffer.from(contentBase64, 'base64')
    const authorizedPath = await authorize(filePath)
    await mkdir(dirname(authorizedPath), { recursive: true })
    await writeFile(authorizedPath, content, { flag: append ? 'a' : 'wx' })
  }
  return {
    readDir: async (dirPath, readOptions = {}) => {
      const entries = await readdir(await authorize(dirPath), { withFileTypes: true })
      const store = options.requireStore()
      return classifyFilesystemDirectoryEntries(
        dirPath,
        entries,
        readOptions.followSymlinks ?? store.getSettings().followSymlinkedDirectories ?? false,
        (path) => resolveAuthorizedPath(path, store)
      )
    },
    readDocPreviewFile: readAuthorizedDocPreviewFile,
    writeFile: async (filePath, content) => {
      const authorizedPath = await authorize(filePath)
      try {
        if ((await lstat(authorizedPath)).isDirectory()) {
          throw new Error('Cannot write to a directory')
        }
      } catch (error) {
        if (!isENOENT(error)) {
          throw error
        }
      }
      await writeFile(authorizedPath, content, 'utf-8')
    },
    writeFileBase64: (filePath, contentBase64) => writeBase64(filePath, contentBase64, false),
    writeFileBase64Chunk: writeBase64,
    stat: async (filePath) => {
      const stats = await stat(await authorize(filePath))
      return {
        size: stats.size,
        type: stats.isDirectory() ? 'directory' : 'file',
        mtime: stats.mtimeMs,
        ctimeMs: stats.ctimeMs
      }
    },
    deletePath: async (targetPath, recursive) => {
      await rm(await authorizeLink(targetPath), { recursive: recursive === true, force: true })
    },
    createFile: async (filePath) => {
      const authorizedPath = await authorize(filePath)
      await mkdir(dirname(authorizedPath), { recursive: true })
      try {
        await writeFile(authorizedPath, '', { encoding: 'utf-8', flag: 'wx' })
      } catch (error) {
        rethrowWithUserMessage(error, authorizedPath)
      }
    },
    createDir: async (dirPath) => {
      const authorizedPath = await authorize(dirPath)
      await assertNotExists(authorizedPath)
      await mkdir(authorizedPath, { recursive: false })
    },
    createDirNoClobber: async (dirPath) => {
      await mkdir(await authorize(dirPath), { recursive: false })
    },
    renameNoClobber: async (oldPath, newPath) => {
      const authorizedOldPath = await authorizeLink(oldPath)
      await renameLocalPathSerializedByDestination(authorizedOldPath, await authorizeLink(newPath))
    },
    copy: async (source, destination) => {
      const authorizedSource = await authorizeLink(source)
      const authorizedDestination = await authorizeLink(destination)
      await mkdir(dirname(authorizedDestination), { recursive: true })
      // Why: COPYFILE_EXCL keeps the no-clobber invariant; callers already deconflict names.
      await copyFile(authorizedSource, authorizedDestination, constants.COPYFILE_EXCL)
    },
    search: async (searchOptions, { signal } = {}) => {
      throwIfSignalAborted(signal)
      const store = options.requireStore()
      const rootPath = await waitForPromiseWithSignal(
        resolveAuthorizedPath(searchOptions.rootPath, store),
        signal
      )
      throwIfSignalAborted(signal)
      const { wslDistro } = getLocalGitOptionsForRegisteredWorktree(
        store,
        searchOptions.rootPath,
        rootPath
      )
      return runBundledRipgrepTextSearch({
        options: searchOptions,
        rootPath,
        resultRootPath: rootPath,
        wslDistro,
        wslDistroForOutput: parseWslPath(rootPath)?.distro ?? wslDistro,
        signal,
        onSpawn: options.onTextSearchSpawn ?? (() => () => undefined)
      })
    },
    listMarkdownDocuments: (rootPath) =>
      listMarkdownDocuments(
        rootPath,
        getLocalGitOptionsForRegisteredWorktree(options.requireStore(), rootPath, rootPath)
      )
  }
}
