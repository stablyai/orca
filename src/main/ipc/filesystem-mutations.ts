/* eslint-disable max-lines -- Why: filesystem mutation IPC handlers stay centralized so
authorization, SSH routing, and external import behavior remain audited together. */
import { ipcMain } from 'electron'
import { constants } from 'fs'
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
  writeFile
} from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { pipeline } from 'stream/promises'
import type { Store } from '../persistence'
import { authorizeExternalPath, resolveAuthorizedPath, isENOENT } from './filesystem-auth'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { importExternalPathsSsh } from './filesystem-import-ssh'

/**
 * Re-throw filesystem errors with user-friendly messages.
 * The `wx` flag on writeFile throws a raw EEXIST with no helpful message,
 * so we catch it here and provide context the renderer can display directly.
 */
function rethrowWithUserMessage(error: unknown, targetPath: string): never {
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

/**
 * Ensure `targetPath` does not already exist. Throws if it does.
 *
 * Note: this is a non-atomic check — a concurrent operation could create the
 * path between `lstat` and the caller's next action. Acceptable for a desktop
 * app with low concurrency; `createFile` uses the `wx` flag for an atomic
 * alternative where possible.
 */
async function assertNotExists(targetPath: string): Promise<void> {
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

/**
 * IPC handlers for file/folder creation and renaming.
 * Deletion is handled separately via `fs:deletePath` (shell.trashItem).
 */
export function registerFilesystemMutationHandlers(store: Store): void {
  ipcMain.handle(
    'fs:createFile',
    async (_event, args: { filePath: string; connectionId?: string }): Promise<void> => {
      if (args.connectionId) {
        const provider = getSshFilesystemProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No filesystem provider for connection "${args.connectionId}"`)
        }
        return provider.createFile(args.filePath)
      }
      const filePath = await resolveAuthorizedPath(args.filePath, store)
      await mkdir(dirname(filePath), { recursive: true })
      try {
        // Use the 'wx' flag for atomic create-if-not-exists, avoiding TOCTOU races
        await writeFile(filePath, '', { encoding: 'utf-8', flag: 'wx' })
      } catch (error) {
        rethrowWithUserMessage(error, filePath)
      }
    }
  )

  ipcMain.handle(
    'fs:createDir',
    async (_event, args: { dirPath: string; connectionId?: string }): Promise<void> => {
      if (args.connectionId) {
        const provider = getSshFilesystemProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No filesystem provider for connection "${args.connectionId}"`)
        }
        return provider.createDir(args.dirPath)
      }
      const dirPath = await resolveAuthorizedPath(args.dirPath, store)
      await assertNotExists(dirPath)
      await mkdir(dirPath, { recursive: true })
    }
  )

  // Note: fs.rename throws EXDEV if old and new paths are on different
  // filesystems/volumes. This is unlikely since both paths are under the same
  // workspace root, but a cross-drive rename would surface as an IPC error.
  ipcMain.handle(
    'fs:rename',
    async (
      _event,
      args: { oldPath: string; newPath: string; connectionId?: string }
    ): Promise<void> => {
      if (args.connectionId) {
        const provider = getSshFilesystemProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No filesystem provider for connection "${args.connectionId}"`)
        }
        return provider.rename(args.oldPath, args.newPath)
      }
      // Why: rename() operates on directory entries, not file contents. If
      // oldPath is a symlink, we must rename the link itself rather than
      // resolving it to its target — following the link would rename the
      // target file (potentially elsewhere in the worktree) and leave the
      // symlink dangling. newPath must also preserve its leaf so we don't
      // accidentally write into a symlinked destination name.
      const oldPath = await resolveAuthorizedPath(args.oldPath, store, { preserveSymlink: true })
      const newPath = await resolveAuthorizedPath(args.newPath, store, { preserveSymlink: true })
      await assertNotExists(newPath)
      await rename(oldPath, newPath)
    }
  )

  ipcMain.handle(
    'fs:copy',
    async (
      _event,
      args: { sourcePath: string; destinationPath: string; connectionId?: string }
    ): Promise<void> => {
      if (args.connectionId) {
        const provider = getSshFilesystemProvider(args.connectionId)
        if (!provider) {
          throw new Error(`No filesystem provider for connection "${args.connectionId}"`)
        }
        return provider.copy(args.sourcePath, args.destinationPath)
      }
      const sourcePath = await resolveAuthorizedPath(args.sourcePath, store, {
        preserveSymlink: true
      })
      const destinationPath = await resolveAuthorizedPath(args.destinationPath, store, {
        preserveSymlink: true
      })
      await mkdir(dirname(destinationPath), { recursive: true })
      // Why: duplicate/copy callers deconflict before copying. COPYFILE_EXCL
      // keeps a late race from silently overwriting an existing file.
      await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL)
    }
  )

  ipcMain.handle(
    'fs:importExternalPaths',
    async (
      _event,
      args: { sourcePaths: string[]; destDir: string; connectionId?: string; ensureDir?: boolean }
    ): Promise<{ results: ImportItemResult[] }> => {
      if (args.connectionId) {
        return importExternalPathsSsh(args.sourcePaths, args.destDir, args.connectionId, {
          ensureDir: args.ensureDir
        })
      }

      // Why: destDir must be authorized before any copy work begins. If the
      // destination is outside allowed roots, the entire import fails.
      // This only applies to local imports — remote paths are authorized by
      // the SSH connection boundary (see importExternalPathsSsh).
      const resolvedDest = await resolveAuthorizedPath(args.destDir, store)

      const results: ImportItemResult[] = []
      const reservedNames = new Set<string>()

      for (const sourcePath of args.sourcePaths) {
        const result = await importOneSource(sourcePath, resolvedDest, reservedNames)
        results.push(result)
        if (result.status === 'imported') {
          reservedNames.add(basename(result.destPath))
        }
      }

      return { results }
    }
  )

  ipcMain.handle(
    'fs:stageExternalPathsForRuntimeUpload',
    async (
      _event,
      args: { sourcePaths: string[] }
    ): Promise<{ sources: StagedExternalImportSource[] }> => {
      const sources: StagedExternalImportSource[] = []
      for (const sourcePath of args.sourcePaths) {
        sources.push(await stageOneSourceForRuntimeUpload(sourcePath))
      }
      return { sources }
    }
  )

  // Why: terminal drag-and-drop resolver. Local worktrees pass paths through
  // unchanged (reference-in-place; preserves zero-latency drop). SSH worktrees
  // upload each path into `${worktreePath}/.orca/drops/` and return remote
  // paths the remote agent can read. Kept as a separate IPC from
  // fs:importExternalPaths because terminal semantics differ from the
  // explorer's "copy into user-picked destDir". See docs/terminal-drop-ssh.md.
  ipcMain.handle(
    'fs:resolveDroppedPathsForAgent',
    async (
      _event,
      args: { paths: string[]; worktreePath: string; connectionId?: string }
    ): Promise<ResolveDroppedPathsResult> => {
      // Why: `== null` (not `!args.connectionId`) so an empty string is
      // treated as a renderer error, not silently routed to the local branch.
      if (args.connectionId == null) {
        return { resolvedPaths: args.paths, skipped: [], failed: [] }
      }
      const worktreePath = args.worktreePath.replace(/\/+$/, '')
      const destDir = `${worktreePath}/.orca/drops`
      const { results } = await importExternalPathsSsh(args.paths, destDir, args.connectionId, {
        ensureDir: true
      })
      const resolvedPaths: string[] = []
      const skipped: { sourcePath: string; reason: ImportSkipReason }[] = []
      const failed: { sourcePath: string; reason: string }[] = []
      // Iterate in input order so injected paths align with the user's drop order.
      for (const r of results) {
        if (r.status === 'imported') {
          resolvedPaths.push(r.destPath)
        } else if (r.status === 'skipped') {
          skipped.push({ sourcePath: r.sourcePath, reason: r.reason })
        } else {
          failed.push({ sourcePath: r.sourcePath, reason: r.reason })
        }
      }
      return { resolvedPaths, skipped, failed }
    }
  )
}

export type ImportSkipReason = 'missing' | 'symlink' | 'permission-denied' | 'unsupported'

export type ResolveDroppedPathsResult = {
  resolvedPaths: string[]
  skipped: { sourcePath: string; reason: ImportSkipReason }[]
  failed: { sourcePath: string; reason: string }[]
}

// ─── External Import Types ──────────────────────────────────────────

export type ImportItemResult =
  | {
      sourcePath: string
      status: 'imported'
      destPath: string
      kind: 'file' | 'directory'
      renamed: boolean
    }
  | {
      sourcePath: string
      status: 'skipped'
      reason: ImportSkipReason
    }
  | {
      sourcePath: string
      status: 'failed'
      reason: string
    }

export type StagedExternalImportSource =
  | {
      sourcePath: string
      status: 'staged'
      name: string
      kind: 'file' | 'directory'
      entries: StagedExternalImportEntry[]
    }
  | {
      sourcePath: string
      status: 'skipped'
      reason: ImportSkipReason
    }
  | {
      sourcePath: string
      status: 'failed'
      reason: string
    }

export type StagedExternalImportEntry =
  | { relativePath: string; kind: 'directory' }
  | { relativePath: string; kind: 'file'; contentBase64: string }

const REMOTE_IMPORT_MAX_FILE_BYTES = 25 * 1024 * 1024
const REMOTE_IMPORT_MAX_TOTAL_BYTES = 100 * 1024 * 1024

// ─── External Import Implementation ─────────────────────────────────

/**
 * Import a single top-level source into destDir, handling authorization,
 * validation, pre-scan, deconfliction, and copy.
 */
async function importOneSource(
  sourcePath: string,
  destDir: string,
  reservedNames: Set<string>
): Promise<ImportItemResult> {
  const resolvedSource = resolve(sourcePath)

  // Why: authorize the external source path so downstream filesystem
  // operations (lstat, readdir, copyFile) are permitted by Electron.
  authorizeExternalPath(resolvedSource)

  // Why: validate source using lstat on the unresolved path *before*
  // canonicalization so top-level symlinks are rejected instead of being
  // silently dereferenced by realpath.
  let sourceStat: Awaited<ReturnType<typeof lstat>>
  try {
    sourceStat = await lstat(resolvedSource)
  } catch (error) {
    if (isENOENT(error)) {
      return { sourcePath, status: 'skipped', reason: 'missing' }
    }
    if (
      error instanceof Error &&
      'code' in error &&
      ((error as NodeJS.ErrnoException).code === 'EACCES' ||
        (error as NodeJS.ErrnoException).code === 'EPERM')
    ) {
      return { sourcePath, status: 'skipped', reason: 'permission-denied' }
    }
    return {
      sourcePath,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error)
    }
  }

  // Why: reject symlinks in v1 — symlink copy semantics differ across
  // platforms, and following them can escape the dropped subtree.
  if (sourceStat.isSymbolicLink()) {
    return { sourcePath, status: 'skipped', reason: 'symlink' }
  }

  if (!sourceStat.isFile() && !sourceStat.isDirectory()) {
    return { sourcePath, status: 'skipped', reason: 'unsupported' }
  }

  const isDir = sourceStat.isDirectory()

  // Why: for directories, pre-scan the entire tree for symlinks before
  // creating any destination files. This prevents partially imported
  // trees when a symlink is discovered halfway through recursive copy.
  if (isDir) {
    const hasSymlink = await preScanForSymlinks(resolvedSource)
    if (hasSymlink) {
      return { sourcePath, status: 'skipped', reason: 'symlink' }
    }
  }

  // Top-level deconfliction: generate a unique name if collision exists
  const originalName = basename(resolvedSource)
  const finalName = await deconflictName(destDir, originalName, reservedNames)
  const destPath = join(destDir, finalName)
  const renamed = finalName !== originalName

  try {
    await (isDir
      ? recursiveCopyDir(resolvedSource, destPath)
      : copyLocalFileNoFollow(resolvedSource, destPath))
  } catch (error) {
    if (isDir) {
      await rm(destPath, { recursive: true, force: true }).catch(() => {})
    }
    return {
      sourcePath,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error)
    }
  }

  return {
    sourcePath,
    status: 'imported',
    destPath,
    kind: isDir ? 'directory' : 'file',
    renamed
  }
}

async function stageOneSourceForRuntimeUpload(
  sourcePath: string
): Promise<StagedExternalImportSource> {
  const resolvedSource = resolve(sourcePath)

  // Why: runtime uploads read client-local paths in the client main process;
  // authorize before lstat/readFile just like local copy imports.
  authorizeExternalPath(resolvedSource)

  let sourceStat: Awaited<ReturnType<typeof lstat>>
  try {
    sourceStat = await lstat(resolvedSource)
  } catch (error) {
    if (isENOENT(error)) {
      return { sourcePath, status: 'skipped', reason: 'missing' }
    }
    if (
      error instanceof Error &&
      'code' in error &&
      ((error as NodeJS.ErrnoException).code === 'EACCES' ||
        (error as NodeJS.ErrnoException).code === 'EPERM')
    ) {
      return { sourcePath, status: 'skipped', reason: 'permission-denied' }
    }
    return {
      sourcePath,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error)
    }
  }

  if (sourceStat.isSymbolicLink()) {
    return { sourcePath, status: 'skipped', reason: 'symlink' }
  }
  if (!sourceStat.isFile() && !sourceStat.isDirectory()) {
    return { sourcePath, status: 'skipped', reason: 'unsupported' }
  }
  if (sourceStat.isDirectory() && (await preScanForSymlinks(resolvedSource))) {
    return { sourcePath, status: 'skipped', reason: 'symlink' }
  }

  try {
    const entries = sourceStat.isDirectory()
      ? await stageDirectoryEntries(resolvedSource)
      : [await stageFileEntry(resolvedSource, '')]
    return {
      sourcePath,
      status: 'staged',
      name: basename(resolvedSource),
      kind: sourceStat.isDirectory() ? 'directory' : 'file',
      entries
    }
  } catch (error) {
    return {
      sourcePath,
      status: 'failed',
      reason: error instanceof Error ? error.message : String(error)
    }
  }
}

async function stageDirectoryEntries(rootPath: string): Promise<StagedExternalImportEntry[]> {
  const entries: StagedExternalImportEntry[] = [{ relativePath: '', kind: 'directory' }]
  let totalBytes = 0
  const rootRealPath = await realpath(rootPath)

  async function visit(dirPath: string): Promise<void> {
    const dirStat = await lstat(dirPath)
    if (dirStat.isSymbolicLink()) {
      throw new Error(
        `Symlink not allowed in '${normalizeRelativeUploadPath(relative(rootPath, dirPath))}'`
      )
    }
    if (!dirStat.isDirectory()) {
      throw new Error(
        `Unsupported file type in '${normalizeRelativeUploadPath(relative(rootPath, dirPath))}'`
      )
    }
    await assertRealPathInsideRoot(
      rootRealPath,
      dirPath,
      normalizeRelativeUploadPath(relative(rootPath, dirPath))
    )
    const dirEntries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of dirEntries) {
      const childPath = join(dirPath, entry.name)
      const childRelativePath = normalizeRelativeUploadPath(relative(rootPath, childPath))
      if (entry.isDirectory()) {
        const childStat = await lstat(childPath)
        if (childStat.isSymbolicLink()) {
          throw new Error(`Symlink not allowed in '${childRelativePath}'`)
        }
        if (!childStat.isDirectory()) {
          throw new Error(`Unsupported file type in '${childRelativePath}'`)
        }
        entries.push({ relativePath: childRelativePath, kind: 'directory' })
        await visit(childPath)
        continue
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported file type in '${childRelativePath}'`)
      }
      const statResult = await lstat(childPath)
      totalBytes += statResult.size
      assertRemoteUploadBudget(childRelativePath, statResult.size, totalBytes)
      entries.push(await stageFileEntry(childPath, childRelativePath, rootRealPath))
    }
  }

  await visit(rootPath)
  return entries
}

async function stageFileEntry(
  filePath: string,
  relativePath: string,
  rootRealPath?: string
): Promise<StagedExternalImportEntry> {
  const statResult = await lstat(filePath)
  const displayPath = normalizeRelativeUploadPath(relativePath)
  if (statResult.isSymbolicLink()) {
    throw new Error(`Symlink not allowed in '${displayPath}'`)
  }
  if (!statResult.isFile()) {
    throw new Error(`Unsupported file type in '${displayPath}'`)
  }
  if (rootRealPath) {
    await assertRealPathInsideRoot(rootRealPath, filePath, displayPath)
  }
  assertRemoteUploadBudget(relativePath, statResult.size, statResult.size)
  const fileHandle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const openedStat = await fileHandle.stat()
    if (!openedStat.isFile()) {
      throw new Error(`Unsupported file type in '${displayPath}'`)
    }
    if (
      openedStat.size !== statResult.size ||
      (statResult.ino !== 0 && openedStat.ino !== 0 && openedStat.ino !== statResult.ino) ||
      (statResult.dev !== 0 && openedStat.dev !== 0 && openedStat.dev !== statResult.dev)
    ) {
      throw new Error(`File changed during upload staging: '${displayPath}'`)
    }
    assertRemoteUploadBudget(relativePath, openedStat.size, openedStat.size)
    const buffer = await fileHandle.readFile()
    const afterReadStat = await fileHandle.stat()
    if (afterReadStat.size !== openedStat.size) {
      throw new Error(`File changed during upload staging: '${displayPath}'`)
    }
    return {
      relativePath: displayPath,
      kind: 'file',
      contentBase64: buffer.toString('base64')
    }
  } finally {
    await fileHandle.close()
  }
}

async function assertRealPathInsideRoot(
  rootRealPath: string,
  candidatePath: string,
  displayPath: string
): Promise<void> {
  const candidateRealPath = await realpath(candidatePath)
  const relativeToRoot = relative(rootRealPath, candidateRealPath)
  if (relativeToRoot !== '' && (relativeToRoot.startsWith('..') || isAbsolute(relativeToRoot))) {
    throw new Error(`Path escaped upload root during staging: '${displayPath}'`)
  }
}

function assertRemoteUploadBudget(
  relativePath: string,
  fileBytes: number,
  totalBytes: number
): void {
  if (fileBytes > REMOTE_IMPORT_MAX_FILE_BYTES) {
    throw new Error(`'${relativePath}' is too large for remote import`)
  }
  if (totalBytes > REMOTE_IMPORT_MAX_TOTAL_BYTES) {
    throw new Error('Remote import is too large')
  }
}

function normalizeRelativeUploadPath(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/^\/+/, '')
}

/**
 * Pre-scan a directory tree for symlinks. Returns true if any symlink
 * is found anywhere in the subtree.
 */
async function preScanForSymlinks(dirPath: string): Promise<boolean> {
  const entries = await readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      return true
    }
    if (entry.isDirectory()) {
      const childPath = join(dirPath, entry.name)
      if (await preScanForSymlinks(childPath)) {
        return true
      }
    }
  }
  return false
}

/**
 * Recursively copy a directory and all its contents. Uses copyFile for
 * individual files to leverage native OS copy primitives instead of
 * buffering entire files into memory.
 */
async function recursiveCopyDir(srcDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: false })
  const entries = await readdir(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name)
    const dstPath = join(destDir, entry.name)
    const statResult = await lstat(srcPath)
    if (statResult.isSymbolicLink()) {
      throw new Error(`Symlink not allowed in '${entry.name}'`)
    }
    if (statResult.isDirectory()) {
      await recursiveCopyDir(srcPath, dstPath)
      continue
    }
    if (!statResult.isFile()) {
      throw new Error(`Unsupported file type in '${entry.name}'`)
    }
    await copyLocalFileNoFollow(srcPath, dstPath, statResult)
  }
}

async function copyLocalFileNoFollow(
  srcPath: string,
  dstPath: string,
  statResult?: Awaited<ReturnType<typeof lstat>>
): Promise<void> {
  const beforeOpenStat = statResult ?? (await lstat(srcPath))
  if (beforeOpenStat.isSymbolicLink()) {
    throw new Error(`Symlink not allowed in '${basename(srcPath)}'`)
  }
  if (!beforeOpenStat.isFile()) {
    throw new Error(`Unsupported file type in '${basename(srcPath)}'`)
  }

  let destinationCreated = false
  const sourceHandle = await open(srcPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let destinationHandle: Awaited<ReturnType<typeof open>> | null = null
  try {
    const openedStat = await sourceHandle.stat()
    if (
      !openedStat.isFile() ||
      (typeof beforeOpenStat.size === 'number' && openedStat.size !== beforeOpenStat.size) ||
      (typeof beforeOpenStat.ino === 'number' &&
        beforeOpenStat.ino !== 0 &&
        openedStat.ino !== 0 &&
        openedStat.ino !== beforeOpenStat.ino) ||
      (typeof beforeOpenStat.dev === 'number' &&
        beforeOpenStat.dev !== 0 &&
        openedStat.dev !== 0 &&
        openedStat.dev !== beforeOpenStat.dev)
    ) {
      throw new Error(`File changed during import: '${basename(srcPath)}'`)
    }
    // Why: copyFile(path, path) would follow a source symlink if the source is
    // swapped after validation. Streaming from an O_NOFOLLOW handle keeps the
    // authorized file identity pinned for the copy.
    destinationHandle = await open(dstPath, 'wx')
    destinationCreated = true
    await pipeline(sourceHandle.createReadStream(), destinationHandle.createWriteStream())
  } catch (error) {
    if (destinationCreated) {
      await unlink(dstPath).catch(() => {})
    }
    throw error
  } finally {
    await sourceHandle.close().catch(() => {})
    await destinationHandle?.close().catch(() => {})
  }
}

/**
 * Generate a unique sibling name in destDir to avoid overwriting existing
 * files or colliding with other items in the same import batch.
 *
 * Pattern: "name copy.ext", "name copy 2.ext", "name copy 3.ext", etc.
 * For directories: "name copy", "name copy 2", "name copy 3", etc.
 */
async function deconflictName(
  destDir: string,
  originalName: string,
  reservedNames: Set<string>
): Promise<string> {
  if (!(await nameExists(destDir, originalName)) && !reservedNames.has(originalName)) {
    return originalName
  }

  const dotIndex = originalName.lastIndexOf('.')
  // Treat the entire name as stem for dotfiles or names without extensions
  const hasMeaningfulExt = dotIndex > 0
  const stem = hasMeaningfulExt ? originalName.slice(0, dotIndex) : originalName
  const ext = hasMeaningfulExt ? originalName.slice(dotIndex) : ''

  let candidate = `${stem} copy${ext}`
  if (!(await nameExists(destDir, candidate)) && !reservedNames.has(candidate)) {
    return candidate
  }

  let counter = 2
  while (counter < 10000) {
    candidate = `${stem} copy ${counter}${ext}`
    if (!(await nameExists(destDir, candidate)) && !reservedNames.has(candidate)) {
      return candidate
    }
    counter += 1
  }

  // Extremely unlikely fallback
  throw new Error(
    `Could not generate a unique name for '${originalName}' after ${counter} attempts`
  )
}

async function nameExists(dir: string, name: string): Promise<boolean> {
  try {
    await lstat(join(dir, name))
    return true
  } catch (error) {
    if (isENOENT(error)) {
      return false
    }
    throw error
  }
}
