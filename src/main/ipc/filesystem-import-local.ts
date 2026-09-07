import { lstat, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { authorizeExternalPath } from './filesystem-auth'
import { isENOENT } from './filesystem-path-containment'
import type { ImportItemResult } from './filesystem-import-result-types'
import {
  copyLocalFileNoFollow,
  preScanForSymlinks,
  recursiveCopyDir
} from './filesystem-import-local-tree-copy'

/**
 * Import a single top-level source into destDir, handling authorization,
 * validation, pre-scan, deconfliction, and copy.
 */
export async function importOneSource(
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
