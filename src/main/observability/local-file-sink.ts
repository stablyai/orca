// Trace writes are queued and appended off the event loop; a stalled disk drops spans instead of freezing the process.

import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { createBoundedLogFileWriter, DEFAULT_MAX_QUEUED_CHARS } from './bounded-log-file-writer'

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
  readonly maxQueuedChars?: number
}

export type LocalFileSink = {
  readonly filePath: string
  push(record: unknown): void
  /** Writes queued records before returning; for crash boundaries only. */
  flush(): void
  /** Resolves once every record pushed before the call has been written or dropped. */
  flushAsync(): Promise<void>
  /** Stops accepting records and flushes like flush(); safe to call from an exit handler. */
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

function droppedRecordMarker(fields: Record<string, unknown>): string {
  return `${JSON.stringify({
    type: DROPPED_RECORD_TYPE,
    ...fields,
    // Let the collector age markers out like spans.
    endTimeUnixNano: `${Date.now()}000000`
  })}\n`
}

export function createLocalFileSink(opts: LocalFileSinkOptions): LocalFileSink {
  const filePath = opts.filePath
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES
  const maxQueuedChars = opts.maxQueuedChars ?? DEFAULT_MAX_QUEUED_CHARS

  // Traces contain paths and crash context; restrict access regardless of umask.
  const traceDirectory = dirname(filePath)
  mkdirSync(traceDirectory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE })
  chmodPathIfPresent(traceDirectory, PRIVATE_DIRECTORY_MODE)
  tightenTraceFamilyPermissions(filePath, maxFiles)

  const writer = createBoundedLogFileWriter({
    filePath,
    maxBytes,
    maxFiles,
    batchWindowMs: opts.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS,
    maxQueuedChars,
    formatDroppedLine: (droppedRecords) =>
      droppedRecordMarker({ reason: 'queue-full', droppedRecords })
  })

  /** Count dropped UTF-16 units to avoid scanning rejected payloads for byte length. */
  function oversizeMarker(record: unknown, droppedChars: number): string | null {
    const span =
      typeof record === 'object' && record !== null ? (record as Record<string, unknown>) : {}
    const name = typeof span.name === 'string' ? span.name.slice(0, MAX_MARKER_NAME_CHARS) : null
    const traceId = typeof span.traceId === 'string' ? span.traceId.slice(0, 32) : null
    const marker = droppedRecordMarker({
      reason: 'oversize',
      droppedChars,
      ...(name === null ? {} : { name }),
      ...(traceId === null ? {} : { traceId })
    })
    return Buffer.byteLength(marker, 'utf8') > maxBytes ? null : marker
  }

  return {
    filePath,
    push(record: unknown): void {
      let line: string
      try {
        line = `${JSON.stringify(record)}\n`
      } catch {
        // Drop unserializable input rather than crash main.
        return
      }
      // UTF-8 uses at most three bytes per UTF-16 unit; small records need no admission scan.
      // A record the queue could never hold gets a named marker instead of an anonymous drop.
      const oversized =
        line.length > maxBytes ||
        line.length > maxQueuedChars ||
        (line.length * 3 > maxBytes && Buffer.byteLength(line, 'utf8') > maxBytes)
      const admitted = oversized ? oversizeMarker(record, line.length) : line
      if (admitted !== null) {
        writer.write(admitted)
      }
    },
    flush: () => writer.flushSync(),
    flushAsync: () => writer.flush(),
    close: () => writer.close()
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
