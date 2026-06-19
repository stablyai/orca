// NDJSON sink with size-based file rotation. Spans are serialized one per
// line to a primary file, and when that file's byte budget is exceeded the
// sink rolls it forward (`main.trace.ndjson` → `main.trace.ndjson.1` →
// `main.trace.ndjson.2` → … → `main.trace.ndjson.N`, oldest deleted).
//
// Defaults match the local-first trace sink design: 10 MB × 10 files. 100 MB
// is the worst-case footprint on a user's disk, keeping the sizing bounded
// without adding a network dependency.
//
// Two design constraints worth calling out:
//
//   1. Synchronous writes by default. The error-tracking lane has to be
//      durable on crash — if the renderer or main process is about to die,
//      a buffered async flush is exactly what we don't want. We use the
//      `appendFileSync` path (cheap on modern fs at this volume) and
//      explicitly do a final `flush()` on shutdown.
//
//   2. Buffered batches with a flush threshold. Batches of up to
//      `FLUSH_BUFFER_THRESHOLD` lines are coalesced into one syscall to
//      keep the per-span cost low; a periodic interval flushes the partial
//      batch every `batchWindowMs` so a sparse-trace session still ends up
//      on disk. Both knobs are configurable for tests.

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

  // Local traces can contain paths and crash context; keep them readable only
  // by the current user even on systems with permissive default umasks.
  const traceDirectory = dirname(filePath)
  mkdirSync(traceDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  chmodPathIfPresent(traceDirectory, PRIVATE_DIRECTORY_MODE)
  tightenTraceFamilyPermissions(filePath, maxFiles)

  // The sink owns one open fd. The fd is recreated on rotation; the rotation
  // routine closes the old fd, renames the file, and opens a fresh one. We
  // use the fd directly (rather than `appendFileSync(filePath, ...)`) so
  // rotation is a clean swap and so we can rely on `fstatSync` for the
  // current-file size — `statSync(filePath)` would race against another
  // process truncating the file under us.
  let fd: number = openAppend(filePath)
  let currentBytes: number = safeFstatSize(fd)

  let buffer: string[] = []
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
      // Fresh-open or fd-out-of-band — start from zero. The next write will
      // size correctly via `currentBytes += chunk.length`.
      return 0
    }
  }

  function rotate(): void {
    // Close the active fd before renaming. Some filesystems (notably CIFS)
    // refuse to rename an open file; we close, rename, then reopen.
    try {
      closeSync(fd)
    } catch {
      /* swallow — best-effort */
    }
    // Cascade rename: `.N-1` → `.N`, `.N-2` → `.N-1`, …, base → `.1`.
    // Walking from highest index down ensures we never overwrite a file we
    // are about to rotate.
    for (let i = maxFiles - 1; i >= 1; i--) {
      const src = i === 1 ? filePath : `${filePath}.${i - 1}`
      const dst = `${filePath}.${i}`
      if (!existsSync(src)) {
        continue
      }
      try {
        if (existsSync(dst)) {
          // The destination shouldn't exist after a clean rotation, but if
          // we're recovering from a crashed prior session, drop stale
          // intermediate files rather than failing the rename.
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
        // Reopen and retry once. If the second write also fails, drop this
        // chunk — the error-tracking lane must never crash main.
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
        // A single pathological span should not violate the documented
        // maxFiles × maxBytes disk envelope. Drop only that record, not the
        // rest of the buffered batch.
        continue
      }
      if (pendingChunkBytes > 0 && currentBytes + pendingChunkBytes + lineBytes > maxBytes) {
        flushPendingChunk()
      }
      // Rotation point: if writing this line would exceed the cap and we
      // already have something in the file, rotate first. Empty-file rotations
      // are skipped (would just produce zero-byte `.N` files on a new install).
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
    // Don't keep the event loop alive purely for the flush timer — quitting
    // is the path that already triggers a final synchronous flush via
    // `close()`, and the periodic flush is a "while running" optimization.
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
        // Circular reference / non-serializable. The redactor handles cycles
        // for us; a stray here means the caller pushed something pre-redact.
        // Drop rather than crash — the local file is best-effort.
        return
      }
      buffer.push(line)
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
      } catch {
        /* swallow */
      }
      closed = true
    }
  }
}

/** Total byte usage across the rotated file family. Used by `bundle.ts` to
 *  size the read buffer and by the Privacy pane to display a footprint hint. */
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

/** List rotated files in age order (newest → oldest) for `bundle.ts` to
 *  iterate when collecting the last N minutes of traces. */
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
