import { statSync } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import { TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT } from '../shared/terminal-scrollback-limits'
import {
  decodeFromFirstUtf8Boundary,
  snapshotReadPaths,
  type TerminalScrollbackSnapshotStorage
} from './terminal-scrollback-snapshots'

/** Whether a non-empty snapshot exists for `ref`; a stat only, so it never reads bytes. */
export function hasTerminalScrollbackSnapshotSync(
  ref: string,
  storage?: TerminalScrollbackSnapshotStorage
): boolean {
  for (const path of snapshotReadPaths(ref, storage)) {
    try {
      if (statSync(path).size > 0) {
        return true
      }
    } catch {
      // Try the legacy/global fallback when a profile-local snapshot is absent.
    }
  }
  return false
}

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

/** Async twin of `readTerminalScrollbackSnapshotSync` for request paths that must not block. */
export async function readTerminalScrollbackSnapshot(
  ref: string,
  storage?: TerminalScrollbackSnapshotStorage
): Promise<string | null> {
  for (const path of snapshotReadPaths(ref, storage)) {
    try {
      return await readTrailingUtf8Async(path, TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT)
    } catch {
      // Try the legacy/global fallback when a profile-local snapshot is absent.
    }
  }
  return null
}
