// Daemon diagnostics must never affect lifecycle or include terminal content or tokens.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_MAX_ROTATED_FILES = 2
const PRIVATE_FILE_MODE = 0o600

/** Includes the active file so diagnostic bundles collect the whole rotated family. */
export const DAEMON_LOG_MAX_FILES = DEFAULT_MAX_ROTATED_FILES + 1

export type DaemonFileLog = {
  log(event: string, details?: Record<string, unknown>): void
  close(): void
}

export type DaemonFileLogOptions = {
  readonly maxBytes?: number
  readonly maxRotatedFiles?: number
}

export function createNoopDaemonFileLog(): DaemonFileLog {
  return {
    log() {},
    close() {}
  }
}

export function createDaemonFileLog(
  filePath: string,
  opts: DaemonFileLogOptions = {}
): DaemonFileLog {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRotatedFiles = opts.maxRotatedFiles ?? DEFAULT_MAX_ROTATED_FILES

  let disabled = false
  let currentBytes = 0

  function disable(): void {
    disabled = true
  }

  try {
    mkdirSync(dirname(filePath), { recursive: true })
    currentBytes = existsSync(filePath) ? statSync(filePath).size : 0
  } catch {
    disable()
  }

  function rotate(): void {
    // Without rotation, preserve the active byte count so the overflow guard remains accurate.
    if (maxRotatedFiles < 1) {
      return
    }
    try {
      for (let i = maxRotatedFiles; i >= 1; i--) {
        const src = i === 1 ? filePath : `${filePath}.${i - 1}`
        const dst = `${filePath}.${i}`
        if (!existsSync(src)) {
          continue
        }
        if (existsSync(dst)) {
          unlinkSync(dst)
        }
        renameSync(src, dst)
      }
      currentBytes = 0
    } catch {
      disable()
    }
  }

  function log(event: string, details: Record<string, unknown> = {}): void {
    if (disabled) {
      return
    }
    let line: string
    try {
      line = `${JSON.stringify({
        src: 'daemon',
        ts: new Date().toISOString(),
        pid: process.pid,
        event,
        ...details
      })}\n`
    } catch {
      // Malformed event details must not disrupt daemon lifecycle.
      return
    }
    const lineBytes = Buffer.byteLength(line, 'utf8')
    if (currentBytes > 0 && currentBytes + lineBytes > maxBytes) {
      rotate()
      if (disabled) {
        return
      }
    }
    try {
      appendFileSync(filePath, line, { mode: PRIVATE_FILE_MODE })
      currentBytes += lineBytes
    } catch {
      disable()
    }
  }

  return {
    log,
    close(): void {
      // Appends are synchronous; there is nothing to flush.
      log('daemon-log-closed')
      disabled = true
    }
  }
}
