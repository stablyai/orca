// Append-only NDJSON logger for the detached daemon process. The daemon runs
// out-of-process with stdio 'ignore', so console output goes nowhere; this
// writes lifecycle events to a rotated file under the app's logs directory so
// they land in diagnostic bundles (windows-terminal-update-survival-plan.md
// §Phase 0). Never log terminal input/output content or tokens.
//
// Two hard constraints:
//   1. FAIL-OPEN. Any error (EACCES, ENOSPC, bad path) disables logging and is
//      swallowed — logging must never throw into daemon lifecycle logic or
//      affect startup/shutdown.
//   2. Best-effort durability. Each line is a single synchronous appendFileSync
//      so a process death mid-write can lose at most the last (partial) line;
//      NDJSON readers skip a truncated trailing line.

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 // 5 MB
const DEFAULT_MAX_ROTATED_FILES = 2 // daemon.log + daemon.log.1 + daemon.log.2
const PRIVATE_FILE_MODE = 0o600

/** Total files in the rotated daemon-log family (active + rotated). The bundle
 *  collector passes this to `listRotatedFiles` so it reads every rotated file. */
export const DAEMON_LOG_MAX_FILES = DEFAULT_MAX_ROTATED_FILES + 1

export type DaemonFileLog = {
  /** Append one lifecycle event. Terse fields only — never user data. */
  log(event: string, details?: Record<string, unknown>): void
  /** Best-effort marker that no further writes are expected. */
  close(): void
}

export type DaemonFileLogOptions = {
  readonly maxBytes?: number
  readonly maxRotatedFiles?: number
}

/** No-op logger used when the daemon was launched without `--log-file` (adopted
 *  old daemons, tests). Keeps every call site unconditional. */
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
    // Unwritable path — stay fail-open; the first log() no-ops via `disabled`.
    disable()
  }

  // Cascade rename base → .1 → .2, dropping the oldest, then reset the active
  // file. Any failure disables logging rather than risking a partial-rotation
  // loop that keeps throwing on every subsequent line.
  function rotate(): void {
    // With no rotated slots there is nothing to cascade; return without the
    // `currentBytes = 0` reset below, which would otherwise falsely report the
    // still-growing active file as empty and defeat the overflow check forever.
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
      // Non-serializable detail (circular ref) — drop the line, never crash.
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
      // Best-effort marker; append is synchronous so there is nothing to flush.
      log('daemon-log-closed')
      disabled = true
    }
  }
}
