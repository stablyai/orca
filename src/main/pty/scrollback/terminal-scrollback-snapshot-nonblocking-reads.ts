import { open, stat } from 'node:fs/promises'
import { runKeyedSerializedOperation } from '../../../shared/concurrency/keyed-serialized-operations'
import { TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT } from '../../../shared/terminal/replay/terminal-scrollback-limits'
import {
  decodeFromFirstUtf8Boundary,
  snapshotReadPaths,
  type TerminalScrollbackSnapshotStorage
} from './terminal-scrollback-snapshots'

/** Byte size of the snapshot `readTerminalScrollbackSnapshot` would read; `null` when absent. */
export async function statTerminalScrollbackSnapshotSize(
  ref: string,
  storage?: TerminalScrollbackSnapshotStorage
): Promise<number | null> {
  for (const path of snapshotReadPaths(ref, storage)) {
    try {
      return (await stat(path)).size
    } catch {
      // Try the legacy/global fallback when a profile-local snapshot is absent.
    }
  }
  return null
}

async function readTrailingUtf8Async(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const size = (await handle.stat()).size
    const length = Math.min(size, maxBytes)
    if (length <= 0) {
      return ''
    }
    const bytes = Buffer.allocUnsafe(length)
    await handle.read(bytes, 0, length, size - length)
    return decodeFromFirstUtf8Boundary(bytes)
  } finally {
    await handle.close()
  }
}

const snapshotReads = new Map<string, Promise<void>>()

/** Read the bounded replay tail without blocking the request owner on disk I/O. */
export async function readTerminalScrollbackSnapshot(
  ref: string,
  storage?: TerminalScrollbackSnapshotStorage
): Promise<string | null> {
  // Async requests share the old single-reader resource bound without blocking the event loop.
  return runKeyedSerializedOperation(snapshotReads, 'snapshot-read', async () => {
    for (const path of snapshotReadPaths(ref, storage)) {
      try {
        return await readTrailingUtf8Async(path, TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT)
      } catch {
        // Try the legacy/global fallback when a profile-local snapshot is absent.
      }
    }
    return null
  })
}
