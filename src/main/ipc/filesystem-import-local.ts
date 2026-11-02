import { lstat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { isENOENT } from './filesystem-path-containment'
import { classifyImportSource } from './filesystem-import-source-stat'
import { deconflictCopyName } from '../../shared/import-copy-name'
import type { ImportItemResult } from '../../shared/filesystem-import-result-types'
import {
  copyLocalFileNoFollow,
  preScanForSymlinks,
  recursiveCopyDir
} from './filesystem-import-local-tree-copy'

/**
 * Import a single top-level source into destDir, handling validation, pre-scan,
 * deconfliction, and copy.
 */
export async function importOneSource(
  sourcePath: string,
  destDir: string,
  reservedNames: Set<string>
): Promise<ImportItemResult> {
  const resolvedSource = resolve(sourcePath)

  const classified = await classifyImportSource(sourcePath, resolvedSource)
  if ('rejection' in classified) {
    return classified.rejection
  }
  const isDir = classified.stat.isDirectory()

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
  const finalName = await deconflictCopyName(originalName, (n) =>
    nameExists(destDir, n).then((exists) => exists || reservedNames.has(n))
  )
  const destPath = join(destDir, finalName)
  const renamed = finalName !== originalName

  try {
    await (isDir
      ? recursiveCopyDir(resolvedSource, destPath)
      : copyLocalFileNoFollow(resolvedSource, destPath))
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
