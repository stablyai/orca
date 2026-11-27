import { open, unlink } from 'node:fs/promises'
import {
  FILE_DELETE_OK,
  isConfirmedFileNotFoundError,
  type FileDeleteIfUnchangedResult,
  type FileWriteDiskPrecondition
} from '../../../shared/file-write/file-write-disk-precondition'
import { getDiskBaselineSignature } from '../../../shared/file-write/disk-baseline-signature'

/**
 * Deletes `path` only if it still holds the bytes `precondition` pinned. The unlink runs while the
 * checked file's own handle is open, so a writer that replaces the name meanwhile can never be what
 * gets deleted: POSIX unlinks the file that was read, and the check and delete are one request rather
 * than a client's separate stat and delete.
 */
export async function deleteLocalFileIfUnchanged(
  path: string,
  precondition: FileWriteDiskPrecondition
): Promise<FileDeleteIfUnchangedResult> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, 'r')
  } catch (error) {
    // A missing placeholder is already the end state the caller wants.
    return { ok: false, diskConflict: isConfirmedFileNotFoundError(error) ? 'missing' : 'changed' }
  }
  try {
    const current = await handle.readFile('utf8')
    if (getDiskBaselineSignature(current) !== precondition.expectedSignature) {
      return { ok: false, diskConflict: 'changed' }
    }
    await unlink(path)
    return FILE_DELETE_OK
  } finally {
    await handle.close().catch(() => undefined)
  }
}

