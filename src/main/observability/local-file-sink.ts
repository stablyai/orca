// Flush synchronously so buffered diagnostics can survive crash boundaries; batch sparse writes on a timer.

import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { dirname } from 'node:path'

const DEFAULT_FLUSH_BUFFER_THRESHOLD = 32
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
export const DEFAULT_MAX_FILES = 10
export const DEFAULT_BATCH_WINDOW_MS = 200
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
export const DROPPED_RECORD_TYPE = 'trace-record-dropped'
const MAX_MARKER_NAME_CHARS = 120

export type LocalFileSinkOptions = {
  readonly filePath: string
  readonly maxBytes?: number
  readonly maxFiles?: number
  readonly batchWindowMs?: number
  readonly flushBufferThreshold?: number
}

export type LocalFileSink = {
  readonly filePath: string
  push(record: unknown): void
  /** Flush buffered lines synchronously. */
  flush(): void
  close(): void
}

function chmodPathIfPresent(path: string, mode: number): void {
  try {
    if (existsSync(path)) {
      chmodSync(path, mode)
    }
  } catch {
    // Permission hardening must not stop trace writes.
  }
}

function tightenTraceFamilyPermissions(filePath: string, maxFiles: number): void {
  for (let i = 0; i < maxFiles; i++) {
    chmodPathIfPresent(i === 0 ? filePath : `${filePath}.${i}`, PRIVATE_FILE_MODE)
  }
}

export function createLocalFileSink(opts: LocalFileSinkOptions): LocalFileSink {
  const filePath = opts.filePath
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES
  const batchWindowMs = opts.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS
  const flushThreshold = opts.flushBufferThreshold ?? DEFAULT_FLUSH_BUFFER_THRESHOLD

  // Traces contain paths and crash context; restrict access regardless of umask.
  const traceDirectory = dirname(filePath)
  mkdirSync(traceDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  chmodPathIfPresent(traceDirectory, PRIVATE_DIRECTORY_MODE)
  tightenTraceFamilyPermissions(filePath, maxFiles)

  // Size the open file descriptor so path replacement cannot race sizing.
  let fd: number = openAppend(filePath)
  let currentBytes: number = safeFstatSize(fd)

  let buffer: (string | null)[] = []
  let timer: NodeJS.Timeout | null = null
  let closed = false

  function openAppend(path: string): number {
    const handle = openSync(path, 'a', PRIVATE_FILE_MODE)
    try {
      fchmodSync(handle, PRIVATE_FILE_MODE)
    } catch {
      // Some Windows volumes reject POSIX chmod.
    }
    return handle
  }

  function safeFstatSize(handle: number): number {
    try {
      return fstatSync(handle).size
    } catch {
      // Fall back to zero; the next write resizes.
      return 0
    }
  }

  function rotate(): void {
    // CIFS and other filesystems may refuse to rename open files.
    try {
      closeSync(fd)
    } catch {}
    for (let i = maxFiles - 1; i >= 1; i--) {
      const src = i === 1 ? filePath : `${filePath}.${i - 1}`
      const dst = `${filePath}.${i}`
      if (!existsSync(src)) {
        continue
      }
      try {
        if (existsSync(dst)) {
          // Remove a destination left by a crashed rotation before renaming.
          unlinkSync(dst)
        }
        renameSync(src, dst)
      } catch {
        // Partial rotation must not crash the process.
      }
    }
    fd = openAppend(filePath)
    currentBytes = 0
  }

  function flushBuffer(): void {
    if (buffer.length === 0 || closed) {
      return
    }
    const lines = buffer
    buffer = []
    let pendingChunk: string[] = []
    let pendingChunkBytes = 0

    function writeChunk(chunkLines: string[], chunkBytes: number): void {
      if (chunkLines.length === 0) {
        return
      }
      const chunk = chunkLines.join('')
      try {
        writeSync(fd, chunk)
        currentBytes += chunkBytes
      } catch {
        // Retry once; optional diagnostics must not crash main.
        try {
          try {
            closeSync(fd)
          } catch {}
          fd = openAppend(filePath)
          writeSync(fd, chunk)
          currentBytes = safeFstatSize(fd)
        } catch {}
      }
    }

    function flushPendingChunk(): void {
      writeChunk(pendingChunk, pendingChunkBytes)
      pendingChunk = []
      pendingChunkBytes = 0
    }

    for (const line of lines) {
      if (line === null) {
        continue
      }
      const lineBytes = Buffer.byteLength(line, 'utf8')
      if (pendingChunkBytes > 0 && currentBytes + pendingChunkBytes + lineBytes > maxBytes) {
        flushPendingChunk()
      }
      // Avoid empty rotated files on new installations.
      if (currentBytes > 0 && currentBytes + lineBytes > maxBytes) {
        rotate()
      }
      pendingChunk.push(line)
      pendingChunkBytes += lineBytes
    }
    flushPendingChunk()
  }

  /** Count dropped UTF-16 units to avoid scanning rejected payloads for byte length. */
  function oversizeMarker(record: unknown, droppedChars: number): string | null {
    const span =
      typeof record === 'object' && record !== null ? (record as Record<string, unknown>) : {}
    const name = typeof span.name === 'string' ? span.name.slice(0, MAX_MARKER_NAME_CHARS) : null
    const traceId = typeof span.traceId === 'string' ? span.traceId.slice(0, 32) : null
    const marker = `${JSON.stringify({
      type: DROPPED_RECORD_TYPE,
      reason: 'oversize',
      droppedChars,
      // Let the collector age markers out like spans.
      endTimeUnixNano: `${Date.now()}000000`,
      ...(name === null ? {} : { name }),
      ...(traceId === null ? {} : { traceId })
    })}\n`
    return Buffer.byteLength(marker, 'utf8') > maxBytes ? null : marker
  }

  function ensureTimer(): void {
    if (timer || closed) {
      return
    }
    timer = setTimeout(() => {
      timer = null
      flushBuffer()
    }, batchWindowMs)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
  }

  return {
    filePath,
    push(record: unknown): void {
      if (closed) {
        return
      }
      let line: string
      try {
        line = `${JSON.stringify(record)}\n`
      } catch {
        // Drop unserializable input rather than crash main.
        return
      }
      // UTF-8 uses at most three bytes per UTF-16 unit; small records need no admission scan.
      const oversized =
        line.length > maxBytes ||
        (line.length * 3 > maxBytes && Buffer.byteLength(line, 'utf8') > maxBytes)
      // Preserve flush timing with a marker slot so rejected records leave a visible gap.
      buffer.push(oversized ? oversizeMarker(record, line.length) : line)
      if (buffer.length >= flushThreshold) {
        flushBuffer()
      } else {
        ensureTimer()
      }
    },
    flush(): void {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      flushBuffer()
    },
    close(): void {
      if (closed) {
        return
      }
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      flushBuffer()
      try {
        closeSync(fd)
      } catch {}
      closed = true
    }
  }
}

export function getRotatedFamilySize(
  filePath: string,
  maxFiles: number = DEFAULT_MAX_FILES
): number {
  let total = 0
  for (let i = 0; i < maxFiles; i++) {
    const path = i === 0 ? filePath : `${filePath}.${i}`
    if (existsSync(path)) {
      try {
        total += statSync(path).size
      } catch {
        // The file may disappear between exists and stat.
      }
    }
  }
  return total
}

/** Newest to oldest. */
export function listRotatedFiles(filePath: string, maxFiles: number = DEFAULT_MAX_FILES): string[] {
  const out: string[] = []
  for (let i = 0; i < maxFiles; i++) {
    const path = i === 0 ? filePath : `${filePath}.${i}`
    if (existsSync(path)) {
      out.push(path)
    }
  }
  return out
}
