import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT } from '../shared/terminal-scrollback-limits'
import { durableWriteTempPath, writeFileDurableSync } from './durable-file-write'
import {
  getTerminalScrollbackSnapshotPath,
  type TerminalScrollbackSnapshotStorage
} from './terminal-scrollback-snapshots'

export function writeTerminalScrollbackStoredBytesDurableSync(args: {
  ref: string
  data: string
  storage?: TerminalScrollbackSnapshotStorage
}): void {
  if (Buffer.byteLength(args.data, 'utf8') > TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT) {
    throw new Error('terminal_scrollback_snapshot_too_large')
  }
  const path = getTerminalScrollbackSnapshotPath(args.ref, args.storage)
  if (!path) {
    throw new Error('terminal_scrollback_snapshot_ref_invalid')
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileDurableSync(durableWriteTempPath(path), path, args.data)
}

export function terminalScrollbackStoredBytesEqualSync(
  ref: string,
  data: string,
  storage?: TerminalScrollbackSnapshotStorage
): boolean {
  const path = getTerminalScrollbackSnapshotPath(ref, storage)
  if (!path) {
    return false
  }
  const expected = Buffer.from(data, 'utf8')
  try {
    return statSync(path).size === expected.length && readFileSync(path).equals(expected)
  } catch {
    return false
  }
}
