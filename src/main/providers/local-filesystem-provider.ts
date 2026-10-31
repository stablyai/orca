import { constants, copyFile, lstat, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { throwIfSignalAborted, waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import {
  readAuthorizedDocPreviewFile,
  readAuthorizedDocPreviewFileChunk
} from '../../shared/doc-preview-file-access'
import { renameLocalPathSerializedByDestination } from '../destination-serialized-local-rename'
import type { resolveAuthorizedPath as ResolveAuthorizedPath } from '../ipc/filesystem/filesystem-auth'
import { isENOENT } from '../ipc/filesystem/filesystem-path-containment'
import {
  assertNotExists,
  rethrowWithUserMessage
} from '../ipc/filesystem/filesystem-create-path-guards'
import { classifyFilesystemDirectoryEntries } from '../ipc/filesystem/filesystem-symlink-directory-entries'
import { getLocalGitOptionsForRegisteredWorktree } from '../ipc/local-worktree-runtime-options'
import { listMarkdownDocuments } from '../ipc/markdown-documents'
import type { RuntimeStore } from '../runtime/runtime-store-contract'
import { runBundledRipgrepTextSearch } from '../ripgrep/bundled-ripgrep-text-search'
import { resolveBundledRipgrepWslRouting } from '../ripgrep/bundled-ripgrep-wsl-routing'
import type { IFilesystemProvider } from './filesystem-provider-contract'
import type {
  FileWriteDiskPrecondition,
  FileWriteResult
} from '../../shared/file-write-disk-precondition'
import { writeLocalTextFileWithDiskPrecondition } from '../ipc/filesystem/local-disk-write-precondition'
import { windowsFsPath } from '../wsl/wsl-unc-drive-fs-path'

export type LocalFilesystemProviderOptions = {
  /** Read lazily so a call that fails earlier never touches the store. */
  requireStore(): RuntimeStore
  /** Injected: the auth layer reaches the host router, so importing it here would be a cycle. */
  resolveAuthorizedPath: typeof ResolveAuthorizedPath
}

/** Local twins for runtime commands; reads/listing/watching retain call sites with different limits/shapes. */
export type LocalFilesystemProvider = Required<
  Pick<IFilesystemProvider, 'listMarkdownDocuments' | 'readDocPreviewFileChunk'>
> &
  Pick<
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
  > & {
    writeFileWithDiskPrecondition(
      filePath: string,
      content: string,
      precondition: FileWriteDiskPrecondition | undefined
    ): Promise<FileWriteResult>
  }

/** Build per call so path authorization uses the current store. */
export function createLocalFilesystemProvider(
  options: LocalFilesystemProviderOptions
): LocalFilesystemProvider {
  const { resolveAuthorizedPath } = options
  // Authorized in the caller's spelling; a UNC drive-mount path is opened by its drive path.
  const authorize = async (path: string) =>
    windowsFsPath(await resolveAuthorizedPath(path, options.requireStore()))
  // Rename/copy/delete must authorize the symlink itself, preserving its target.
  const authorizeLink = async (path: string) =>
    windowsFsPath(
      await resolveAuthorizedPath(path, options.requireStore(), { preserveSymlink: true })
    )
  const writeBase64 = async (filePath: string, contentBase64: string, append: boolean) => {
    const content = Buffer.from(contentBase64, 'base64')
    const authorizedPath = await authorize(filePath)
    await mkdir(dirname(authorizedPath), { recursive: true })
    await writeFile(authorizedPath, content, { flag: append ? 'a' : 'wx' })
  }
  const writeTextFile = async (
    filePath: string,
    content: string,
    precondition: FileWriteDiskPrecondition | undefined
  ): Promise<FileWriteResult> => {
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
    return writeLocalTextFileWithDiskPrecondition(authorizedPath, content, precondition)
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
    readDocPreviewFileChunk: readAuthorizedDocPreviewFileChunk,
    writeFile: async (filePath, content) => {
      await writeTextFile(filePath, content, undefined)
    },
    writeFileWithDiskPrecondition: writeTextFile,
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
      // Callers deconflict names; COPYFILE_EXCL preserves no-clobber if a destination appears meanwhile.
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
      const { wslDistro, wslDistroForOutput } = resolveBundledRipgrepWslRouting(
        rootPath,
        getLocalGitOptionsForRegisteredWorktree(store, searchOptions.rootPath, rootPath).wslDistro
      )
      return runBundledRipgrepTextSearch({
        options: searchOptions,
        rootPath,
        resultRootPath: rootPath,
        wslDistro,
        wslDistroForOutput,
        signal,
        // Request abort owns cancellation; only renderer IPC needs a by-id registry.
        onSpawn: () => () => undefined
      })
    },
    listMarkdownDocuments: (rootPath) =>
      listMarkdownDocuments(
        rootPath,
        getLocalGitOptionsForRegisteredWorktree(options.requireStore(), rootPath, rootPath)
      )
  }
}
