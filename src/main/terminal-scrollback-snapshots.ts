import { createHash } from 'crypto'
import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { WorkspaceSessionState } from '../shared/types'
import {
  TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT,
  TERMINAL_SCROLLBACK_STORE_BYTE_LIMIT
} from '../shared/terminal-scrollback-limits'

const SNAPSHOT_DIR_NAME = 'terminal-scrollback'
const REF_PREFIX = 'v1'

function getSnapshotRoot(): string {
  return join(app.getPath('userData'), SNAPSHOT_DIR_NAME)
}

export function makeTerminalScrollbackSnapshotRef(tabId: string, leafId: string): string {
  const hash = createHash('sha256').update(`${tabId}\0${leafId}`).digest('hex').slice(0, 32)
  return `${REF_PREFIX}-${hash}`
}

function snapshotPath(ref: string): string | null {
  if (!/^v1-[0-9a-f]{32}$/.test(ref)) {
    return null
  }
  return join(getSnapshotRoot(), `${ref}.bin`)
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
}): string | null {
  if (!args.buffer) {
    return null
  }
  const ref = makeTerminalScrollbackSnapshotRef(args.tabId, args.leafId)
  const path = snapshotPath(ref)
  if (!path) {
    return null
  }
  try {
    mkdirSync(getSnapshotRoot(), { recursive: true, mode: 0o700 })
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
    console.warn(
      `[terminal-scrollback] Failed to write snapshot: ${err instanceof Error ? err.message : String(err)}`
    )
    return null
  }
}

export function readTerminalScrollbackSnapshotSync(ref: string): string | null {
  const path = snapshotPath(ref)
  if (!path) {
    return null
  }
  try {
    return readTrailingUtf8(path, TERMINAL_SCROLLBACK_REPLAY_BYTE_LIMIT)
  } catch {
    return null
  }
}

export function deleteTerminalScrollbackSnapshotSync(ref: string): void {
  const path = snapshotPath(ref)
  if (!path) {
    return
  }
  try {
    rmSync(path, { force: true })
  } catch {
    // Best-effort cleanup; stale refs are harmless and bounded by per-file caps.
  }
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

export function migrateWorkspaceSessionTerminalScrollbackSnapshots(
  session: WorkspaceSessionState
): { session: WorkspaceSessionState; changed: boolean } {
  let terminalLayoutsByTabId: WorkspaceSessionState['terminalLayoutsByTabId'] | null = null
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
    const buffers = layout.buffersByLeafId
    if (!buffers || Object.keys(buffers).length === 0) {
      continue
    }
    const refs = { ...layout.scrollbackRefsByLeafId }
    const remainingBuffers: Record<string, string> = {}
    let layoutChanged = false
    for (const [leafId, buffer] of Object.entries(buffers)) {
      const ref = writeTerminalScrollbackSnapshotSync({ tabId, leafId, buffer })
      if (ref) {
        refs[leafId] = ref
        layoutChanged = true
      } else {
        remainingBuffers[leafId] = buffer
        if (refs[leafId]) {
          delete refs[leafId]
          layoutChanged = true
        }
      }
    }
    if (!layoutChanged) {
      continue
    }
    terminalLayoutsByTabId ??= { ...session.terminalLayoutsByTabId }
    const nextLayout = { ...layout }
    if (Object.keys(refs).length > 0) {
      nextLayout.scrollbackRefsByLeafId = refs
    } else {
      delete nextLayout.scrollbackRefsByLeafId
    }
    if (Object.keys(remainingBuffers).length > 0) {
      nextLayout.buffersByLeafId = remainingBuffers
    } else {
      delete nextLayout.buffersByLeafId
    }
    terminalLayoutsByTabId[tabId] = nextLayout
  }
  if (!terminalLayoutsByTabId) {
    return { session, changed: false }
  }
  return { session: { ...session, terminalLayoutsByTabId }, changed: true }
}
