// NDJSON trace sink with size-based rotation (`main.trace.ndjson` → `.1` → … → `.N`, oldest deleted).
// Defaults 10 MB × 10 files bound the on-disk footprint at ~100 MB with no network dependency.
// Writes are synchronous so the error-tracking lane survives a crash — an async buffered flush is
// exactly what we don't want when main/renderer is about to die. Lines batch into one syscall, with
// a periodic `batchWindowMs` flush so sparse-trace sessions still land on disk.

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
import { stringifyJsonWithinByteLimit } from '../../shared/node-bounded-json-stringify'

const DEFAULT_FLUSH_BUFFER_THRESHOLD = 32
export const DEFAULT_FLUSH_BUFFER_BYTE_THRESHOLD = 1024 * 1024
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 // 10 MB
export const DEFAULT_MAX_FILES = 10
export const DEFAULT_BATCH_WINDOW_MS = 200
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

export type LocalFileSinkOptions = {
  readonly filePath: string
  readonly maxBytes?: number
  readonly maxFiles?: number
  readonly batchWindowMs?: number
  readonly flushBufferThreshold?: number
  readonly flushBufferByteThreshold?: number
}

export type LocalFileSink = {
  readonly filePath: string
  /** Serialize and enqueue one JSON-shaped record. */
  push(record: unknown): void
  /** Force any buffered lines to disk synchronously. Called from shutdown. */
  flush(): void
  /** Stop the periodic timer + flush + close the underlying fd. */
  close(): void
}

function chmodPathIfPresent(path: string, mode: number): void {
  try {
    if (existsSync(path)) {
      chmodSync(path, mode)
    }
  } catch {
    /* best effort — permissions hardening must not break trace writes */
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
  const requestedFlushByteThreshold =
    opts.flushBufferByteThreshold ?? DEFAULT_FLUSH_BUFFER_BYTE_THRESHOLD
  const flushByteThreshold = Number.isFinite(requestedFlushByteThreshold)
    ? Math.max(
        1,
        Math.min(DEFAULT_FLUSH_BUFFER_BYTE_THRESHOLD, Math.trunc(requestedFlushByteThreshold))
      )
    : DEFAULT_FLUSH_BUFFER_BYTE_THRESHOLD

  // Traces hold paths and crash context; lock to current-user regardless of umask.
  const traceDirectory = dirname(filePath)
  mkdirSync(traceDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  chmodPathIfPresent(traceDirectory, PRIVATE_DIRECTORY_MODE)
  tightenTraceFamilyPermissions(filePath, maxFiles)

  // Hold the fd directly (not `appendFileSync`) so fstatSync sizing can't race another process truncating the file.
  let fd: number = openAppend(filePath)
  let currentBytes: number = safeFstatSize(fd)

  let buffer: string[] = []
  let bufferBytes = 0
  let timer: NodeJS.Timeout | null = null
  let closed = false

  function openAppend(path: string): number {
    const handle = openSync(path, 'a', PRIVATE_FILE_MODE)
    try {
      fchmodSync(handle, PRIVATE_FILE_MODE)
    } catch {
      /* best effort — Windows can reject POSIX-style chmod on some volumes */
    }
    return handle
  }

  function safeFstatSize(handle: number): number {
    try {
      return fstatSync(handle).size
    } catch {
      // fstat failed (fresh-open / out-of-band fd); start at 0 — the next write re-sizes.
      return 0
    }
  }

  function rotate(): void {
    // Close fd before rename: some filesystems (notably CIFS) refuse to rename an open file.
    try {
      closeSync(fd)
    } catch {
      /* swallow — best-effort */
    }
    // Cascade base → `.1` → … → `.N`, walking highest index down so we never overwrite a file we still need.
    for (let i = maxFiles - 1; i >= 1; i--) {
      const src = i === 1 ? filePath : `${filePath}.${i - 1}`
      const dst = `${filePath}.${i}`
      if (!existsSync(src)) {
        continue
      }
      try {
        if (existsSync(dst)) {
          // Stale dst left by a crashed prior session; drop it rather than fail the rename.
          unlinkSync(dst)
        }
        renameSync(src, dst)
      } catch {
        /* keep going — partial rotation is preferable to crash */
      }
    }
    // The post-cascade slot is empty; reopen the base file fresh.
    fd = openAppend(filePath)
    currentBytes = 0
  }

  function flushBuffer(): void {
    if (buffer.length === 0 || closed) {
      return
    }
    const lines = buffer
    buffer = []
    bufferBytes = 0
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
        // Reopen + retry once; if that also fails, drop the chunk — telemetry must never crash main.
        try {
          // Best-effort close of the prior fd to prevent fd-leak on transient errors.
          try {
            closeSync(fd)
          } catch {
            /* swallow — best effort */
          }
          fd = openAppend(filePath)
          writeSync(fd, chunk)
          currentBytes = safeFstatSize(fd)
        } catch {
          /* swallow — telemetry must never crash main */
        }
      }
    }

    function flushPendingChunk(): void {
      writeChunk(pendingChunk, pendingChunkBytes)
      pendingChunk = []
      pendingChunkBytes = 0
    }

    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line, 'utf8')
      if (lineBytes > maxBytes) {
        // Oversized single span would blow the maxFiles × maxBytes envelope; drop just this record.
        continue
      }
      if (pendingChunkBytes > 0 && currentBytes + pendingChunkBytes + lineBytes > maxBytes) {
        flushPendingChunk()
      }
      // Skip empty-file rotations (currentBytes > 0) so a new install never produces zero-byte `.N` files.
      if (currentBytes > 0 && currentBytes + lineBytes > maxBytes) {
        rotate()
      }
      pendingChunk.push(line)
      pendingChunkBytes += lineBytes
    }
    flushPendingChunk()
  }

  function ensureTimer(): void {
    if (timer || closed) {
      return
    }
    timer = setTimeout(() => {
      timer = null
      flushBuffer()
    }, batchWindowMs)
    // unref so the flush timer can't keep the process alive; close() does the final flush on quit.
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
      let lineBytes: number
      try {
        const serialized = stringifyJsonWithinByteLimit(record, Math.max(0, maxBytes - 1))
        line = `${serialized.serialized}\n`
        lineBytes = serialized.byteLength + 1
      } catch {
        // Redactor handles cycles upstream; a throw here means pre-redact data slipped in — drop rather than crash (best-effort).
        return
      }
      if (bufferBytes > 0 && bufferBytes + lineBytes > flushByteThreshold) {
        flushBuffer()
      }
      buffer.push(line)
      bufferBytes += lineBytes
      if (buffer.length >= flushThreshold || bufferBytes >= flushByteThreshold) {
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
      } catch {
        /* swallow */
      }
      closed = true
    }
  }
}

/** Total byte usage across the rotated file family (read-buffer sizing + Privacy footprint hint). */
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
        /* ignore — file disappeared between exists and stat */
      }
    }
  }
  return total
}

/** Rotated files in age order (newest → oldest) for `bundle.ts` trace collection. */
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
