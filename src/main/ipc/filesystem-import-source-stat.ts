import type { Stats } from 'node:fs'
import { lstat } from 'node:fs/promises'
import type { ImportSkipReason } from '../../shared/filesystem-import-result-types'
import { errorMessage } from '../../shared/error-message'
import { isPermissionError } from '../win32-utils'
import { isENOENT } from './filesystem-path-containment'

export type ImportSourceRejection =
  | { sourcePath: string; status: 'skipped'; reason: ImportSkipReason }
  | { sourcePath: string; status: 'failed'; reason: string }

export async function classifyImportSource(
  sourcePath: string,
  resolvedSource: string
): Promise<{ stat: Stats } | { rejection: ImportSourceRejection }> {
  // Why: lstat the unresolved path before canonicalization so top-level symlinks are rejected, not dereferenced.
  let stat: Stats
  try {
    stat = await lstat(resolvedSource)
  } catch (error) {
    if (isENOENT(error)) {
      return { rejection: { sourcePath, status: 'skipped', reason: 'missing' } }
    }
    if (isPermissionError(error)) {
      return { rejection: { sourcePath, status: 'skipped', reason: 'permission-denied' } }
    }
    return { rejection: { sourcePath, status: 'failed', reason: errorMessage(error) } }
  }
  // Why: symlink copy semantics differ across platforms, and following one can escape the dropped subtree.
  if (stat.isSymbolicLink()) {
    return { rejection: { sourcePath, status: 'skipped', reason: 'symlink' } }
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    return { rejection: { sourcePath, status: 'skipped', reason: 'unsupported' } }
  }
  return { stat }
}
