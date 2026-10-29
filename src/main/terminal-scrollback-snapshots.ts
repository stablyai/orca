import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'

import { createHash } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getAppEnvironment } from '../shared/app-environment'

import {
  TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT,
  TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT
} from '../shared/terminal-scrollback-limits'
import { errorMessage } from '../shared/error-message'

const SNAPSHOT_DIR_NAME = 'terminal-scrollback'
const REF_PREFIX = 'v1'

export type TerminalScrollbackSnapshotStorage = {
  snapshotRoot?: string
  fallbackSnapshotRoot?: string | null
}

function getLegacySnapshotRoot(): string {
  return join(getAppEnvironment().getPath('userData'), SNAPSHOT_DIR_NAME)
}

export function getProfileTerminalScrollbackSnapshotRoot(dataFile: string): string {
  return join(dirname(dataFile), SNAPSHOT_DIR_NAME)
}

export function getTerminalScrollbackSnapshotRoot(
  storage?: TerminalScrollbackSnapshotStorage
): string {
  return storage?.snapshotRoot ?? getLegacySnapshotRoot()
}

export function makeTerminalScrollbackSnapshotRef(tabId: string, leafId: string): string {
  const hash = createHash('sha256').update(`${tabId}\0${leafId}`).digest('hex').slice(0, 32)
  return `${REF_PREFIX}-${hash}`
}

function snapshotPath(ref: string, snapshotRoot: string): string | null {
  if (!/^v1-[0-9a-f]{32}$/.test(ref)) {
    return null
  }
  return join(snapshotRoot, `${ref}.bin`)
}

export function snapshotReadPaths(
  ref: string,
  storage?: TerminalScrollbackSnapshotStorage
): string[] {
  const primaryRoot = getTerminalScrollbackSnapshotRoot(storage)
  const primaryPath = snapshotPath(ref, primaryRoot)
  if (!primaryPath) {
    return []
  }
  const fallbackRoot = storage?.fallbackSnapshotRoot ?? null
  if (!fallbackRoot || fallbackRoot === primaryRoot) {
    return [primaryPath]
  }
  const fallbackPath = snapshotPath(ref, fallbackRoot)
  return fallbackPath ? [primaryPath, fallbackPath] : [primaryPath]
}

export function getTerminalScrollbackSnapshotPath(
  ref: string,
  storage?: TerminalScrollbackSnapshotStorage
): string | null {
  return snapshotPath(ref, getTerminalScrollbackSnapshotRoot(storage))
}

export function readTerminalScrollbackStoredBytesSync(
  ref: string,
  storage?: TerminalScrollbackSnapshotStorage
): Buffer | null {
  const bytes = readTerminalScrollbackStoredSnapshotSync(ref, storage)
  return bytes === 'absent' ? null : bytes
}

/** `'absent'` when no root holds saved bytes; `null` when a snapshot exists but can't be read. */
export function readTerminalScrollbackStoredSnapshotSync(
  ref: string,
  storage?: TerminalScrollbackSnapshotStorage
): Buffer | 'absent' | null {
  const paths = snapshotReadPaths(ref, storage)
  let unreadable = paths.length === 0
  for (const path of paths) {
    try {
      if (statSync(path).size > TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT) {
        return null
      }
      const bytes = readFileSync(path)
      // An empty file holds no history, but another root may.
      if (bytes.length > 0) {
        return bytes
      }
    } catch (error) {
      unreadable ||= !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
    }
  }
  return unreadable ? null : 'absent'
}

function trailingUtf8Bytes(value: string, maxBytes: number): Buffer {
  const bytes = Buffer.from(value, 'utf-8')
  if (bytes.length <= maxBytes) {
    return bytes
  }
  let start = bytes.length - maxBytes
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
    start++
  }
  return bytes.subarray(start)
}

function readTrailingUtf8(path: string, maxBytes: number): string {
  const size = statSync(path).size
  const length = Math.min(size, maxBytes)
  if (length <= 0) {
    return ''
  }
  const bytes = Buffer.allocUnsafe(length)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, bytes, 0, length, size - length)
  } finally {
    closeSync(fd)
  }
  return decodeFromFirstUtf8Boundary(bytes)
}

/** Decodes a tail slice, skipping continuation bytes of a character the slice cut in half. */
export function decodeFromFirstUtf8Boundary(bytes: Buffer): string {
  let start = 0
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) {
    start++
  }
  return bytes.subarray(start).toString('utf-8')
}

export function writeTerminalScrollbackSnapshotSync(args: {
  tabId: string
  leafId: string
  buffer: string
  storage?: TerminalScrollbackSnapshotStorage
}): string | null {
  if (!args.buffer) {
    return null
  }
  const ref = makeTerminalScrollbackSnapshotRef(args.tabId, args.leafId)
  const snapshotRoot = getTerminalScrollbackSnapshotRoot(args.storage)
  const path = snapshotPath(ref, snapshotRoot)
  if (!path) {
    return null
  }
  try {
    mkdirSync(snapshotRoot, { recursive: true, mode: 0o700 })
    const tmpPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    const bytes = trailingUtf8Bytes(args.buffer, TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT)
    let renamed = false
    try {
      writeFileSync(tmpPath, bytes, { mode: 0o600 })
      renameSync(tmpPath, path)
      renamed = true
    } finally {
      if (!renamed) {
        rmSync(tmpPath, { force: true })
      }
    }
    return ref
  } catch (err) {
    console.warn(`[terminal-scrollback] Failed to write snapshot: ${errorMessage(err)}`)
    return null
  }
}

export type PreparedTerminalScrollbackSnapshot = {
  commit: () => string | null
  discard: () => Promise<void>
}

/** Prepare bytes off-thread; the admitted unit commits its rename and publication without yielding. */
export async function prepareTerminalScrollbackSnapshot(args: {
  tabId: string
  leafId: string
  buffer: string
  storage?: TerminalScrollbackSnapshotStorage
}): Promise<PreparedTerminalScrollbackSnapshot | null> {
  if (!args.buffer) {
    return null
  }
  const ref = makeTerminalScrollbackSnapshotRef(args.tabId, args.leafId)
  const snapshotRoot = getTerminalScrollbackSnapshotRoot(args.storage)
  const path = snapshotPath(ref, snapshotRoot)
  if (!path) {
    return null
  }
  const tmpPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  let committed = false
  const discard = async (): Promise<void> => {
    if (!committed) {
      await rm(tmpPath, { force: true }).catch(() => {})
    }
  }
  try {
    await mkdir(snapshotRoot, { recursive: true, mode: 0o700 })
    await writeFile(tmpPath, trailingUtf8Bytes(args.buffer, TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT), {
      mode: 0o600
    })
    return {
      commit: () => {
        try {
          renameSync(tmpPath, path)
          committed = true
          return ref
        } catch (error) {
          console.warn(`[terminal-scrollback] Failed to commit snapshot: ${errorMessage(error)}`)
          return null
        }
      },
      discard
    }
  } catch (error) {
    await discard()
    console.warn(`[terminal-scrollback] Failed to prepare snapshot: ${errorMessage(error)}`)
    return null
  }
}

export async function writeTerminalScrollbackSnapshot(args: {
  tabId: string
  leafId: string
  buffer: string
  storage?: TerminalScrollbackSnapshotStorage
}): Promise<string | null> {
  const prepared = await prepareTerminalScrollbackSnapshot(args)
  if (!prepared) {
    return null
  }
  try {
    return prepared.commit()
  } finally {
    await prepared.discard()
  }
}

export function readTerminalScrollbackSnapshotSync(
  ref: string,
  storage?: TerminalScrollbackSnapshotStorage
): string | null {
  for (const path of snapshotReadPaths(ref, storage)) {
    try {
      return readTrailingUtf8(path, TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT)
    } catch {
      // Try the next snapshot root when this read fails.
    }
  }
  return null
}

export function deleteTerminalScrollbackSnapshotSync(
  ref: string,
  storage?: TerminalScrollbackSnapshotStorage
): void {
  for (const path of snapshotReadPaths(ref, storage)) {
    try {
      rmSync(path, { force: true })
    } catch {
      // Cleanup failures must not block session deletion.
    }
  }
}

export async function deleteTerminalScrollbackSnapshot(
  ref: string,
  storage?: TerminalScrollbackSnapshotStorage
): Promise<void> {
  await Promise.all(
    snapshotReadPaths(ref, storage).map((path) => rm(path, { force: true }).catch(() => {}))
  )
}

export function collectTerminalScrollbackSnapshotRefs(session: WorkspaceSessionState): Set<string> {
  const refs = new Set<string>()
  for (const layout of Object.values(session.terminalLayoutsByTabId ?? {})) {
    for (const ref of Object.values(layout.scrollbackRefsByLeafId ?? {})) {
      refs.add(ref)
    }
  }
  return refs
}
