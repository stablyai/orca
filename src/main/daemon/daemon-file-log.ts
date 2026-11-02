// Daemon diagnostics must never affect lifecycle or include terminal content or tokens.

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createBoundedLogFileWriter } from '../observability/bounded-log-file-writer'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_ROTATED_FILES = 2
const BATCH_WINDOW_MS = 50

/** Includes the active file so diagnostic bundles collect the whole rotated family. */
export const DAEMON_LOG_MAX_FILES = DEFAULT_MAX_ROTATED_FILES + 1

export type DaemonFileLog = {
  log(event: string, details?: Record<string, unknown>): void
  /** Appends the queued tail synchronously; call right before exit. */
  close(): void
}

export type DaemonFileLogOptions = {
  readonly maxBytes?: number
  readonly maxRotatedFiles?: number
  readonly maxQueuedChars?: number
}

export function createNoopDaemonFileLog(): DaemonFileLog {
  return {
    log() {},
    close() {}
  }
}

function formatDaemonLogLine(event: string, details: Record<string, unknown>): string {
  return `${JSON.stringify({
    src: 'daemon',
    ts: new Date().toISOString(),
    pid: process.pid,
    event,
    ...details
  })}\n`
}

export function createDaemonFileLog(
  filePath: string,
  opts: DaemonFileLogOptions = {}
): DaemonFileLog {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
  } catch {
    return createNoopDaemonFileLog()
  }
  const writer = createBoundedLogFileWriter({
    filePath,
    maxBytes: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    maxFiles: (opts.maxRotatedFiles ?? DEFAULT_MAX_ROTATED_FILES) + 1,
    batchWindowMs: BATCH_WINDOW_MS,
    maxQueuedChars: opts.maxQueuedChars,
    formatDroppedLine: (count) => formatDaemonLogLine('log-entries-dropped', { count })
  })

  function log(event: string, details: Record<string, unknown> = {}): void {
    let line: string
    try {
      line = formatDaemonLogLine(event, details)
    } catch {
      // Malformed event details must not disrupt daemon lifecycle.
      return
    }
    writer.write(line)
  }

  return {
    log,
    close(): void {
      log('daemon-log-closed')
      writer.close()
    }
  }
}
