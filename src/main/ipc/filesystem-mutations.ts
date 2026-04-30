import { ipcMain } from 'electron'
import { copyFile, lstat, mkdir, readdir, rename, writeFile } from 'fs/promises'
import { basename, dirname, join, resolve } from 'path'
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
    'fs:importExternalPaths',
    async (
      _event,
      args: { sourcePaths: string[]; destDir: string; connectionId?: string }
    ): Promise<{ results: ImportItemResult[] }> => {
      if (args.connectionId) {
        return importExternalPathsSsh(args.sourcePaths, args.destDir, args.connectionId)
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
      reason: 'missing' | 'symlink' | 'permission-denied' | 'unsupported'
    }
  | {
      sourcePath: string
      status: 'failed'
      reason: string
    }

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
    await (isDir ? recursiveCopyDir(resolvedSource, destPath) : copyFile(resolvedSource, destPath))
  } catch (error) {
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
  await mkdir(destDir, { recursive: true })
  const entries = await readdir(srcDir, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(srcDir, entry.name)
    const dstPath = join(destDir, entry.name)
    await (entry.isDirectory() ? recursiveCopyDir(srcPath, dstPath) : copyFile(srcPath, dstPath))
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
