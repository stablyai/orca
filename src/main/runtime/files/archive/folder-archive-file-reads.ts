import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import type { FolderArchiveEntry } from './folder-archive-walk'

/** Files up to this size are read whole, ahead of the zipper, so per-file open/stat/close overlaps. */
const SMALL_FILE_BYTES = 64 * 1024

export type SmallFileRead =
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'skip'; error: unknown }
  /** Grew past the small-file limit since the walk; stream it instead. */
  | { kind: 'stream' }

export class ChangedSinceWalkError extends Error {}

export function isSmallFile(entry: FolderArchiveEntry): boolean {
  return entry.kind === 'file' && entry.size <= SMALL_FILE_BYTES
}

/**
 * Opens a planned file without following a final link, and refuses it if it is no longer the file
 * the walk saw. A parent directory swapped for a link after the walk slips past O_NOFOLLOW but
 * changes dev/ino, so nothing outside the root is ever read.
 */
export async function openUnchangedFile(entry: FolderArchiveEntry): Promise<FileHandle> {
  const handle = await open(entry.absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) {
      throw new ChangedSinceWalkError('archive_entry_changed')
    }
    return handle
  } catch (error) {
    await handle.close().catch(() => {})
    throw error
  }
}

/** Never rejects: failures come back as `skip` so a look-ahead read cannot go unhandled. */
export async function readSmallFile(entry: FolderArchiveEntry): Promise<SmallFileRead> {
  let handle: FileHandle
  try {
    handle = await openUnchangedFile(entry)
  } catch (error) {
    return { kind: 'skip', error }
  }
  try {
    // One spare byte tells a file that grew since the walk apart from one that matches.
    const buffer = Buffer.allocUnsafe(Math.min(entry.size, SMALL_FILE_BYTES) + 1)
    let filled = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, filled, buffer.byteLength - filled, filled)
      if (bytesRead === 0) {
        return { kind: 'bytes', bytes: buffer.subarray(0, filled) }
      }
      filled += bytesRead
      if (filled === buffer.byteLength) {
        return { kind: 'stream' }
      }
    }
  } catch (error) {
    return { kind: 'skip', error }
  } finally {
    await handle.close().catch(() => {})
  }
}
