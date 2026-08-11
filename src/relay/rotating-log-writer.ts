// Size-capped, crash-safe rotation for the relay's diagnostic log.
//
// Why: the relay is launched detached with `> relay.log 2>&1`, which only
// truncates at relaunch — a long-lived relay's relay.log grows unbounded
// (per-stream stderr lines, reconnect flaps, etc.). Rotation must live in the
// relay process because it owns its own stderr; the shell redirect cannot cap
// size. Constraints honored:
//  - keeps working when the launch fd is a pipe/redirect on Linux/macOS/Windows
//    (append-only, no fd tricks; a rotation failure falls back to the prior fd);
//  - the diagnostics tail (`tail -100 ~/.orca-remote/relay-*/relay.log`) keeps
//    working because the CURRENT log is always at relay.log;
//  - crash-safe: writes and rotation are guarded so logging never throws, and
//    rotation renames (never deletes the live file) so no window loses logging.
import { closeSync, openSync, renameSync, statSync, writeSync } from 'node:fs'

/** Default size cap before rotating relay.log → relay.log.1. 10 MB balances
 * keeping enough history for diagnosis against bounding disk use on small
 * remote hosts (e.g. a Raspberry Pi); one archived generation is kept. */
export const DEFAULT_RELAY_LOG_MAX_BYTES = 10 * 1024 * 1024

type StreamWrite = typeof process.stderr.write

export class RotatingLogWriter {
  private readonly logPath: string
  private readonly rotatedPath: string
  private readonly maxBytes: number
  private fd: number | null = null
  private currentBytes = 0
  private failed = false

  constructor(logPath: string, maxBytes: number = DEFAULT_RELAY_LOG_MAX_BYTES) {
    this.logPath = logPath
    this.rotatedPath = `${logPath}.1`
    this.maxBytes = maxBytes
    this.open()
  }

  private open(mode: 'a' | 'w' = 'a'): void {
    try {
      // 'a' preserves pre-JS boot output already in relay.log and keeps
      // concurrent appends atomic; 'w' truncates in place (used as the rotation
      // fallback when a rename cannot succeed — e.g. Windows, where the launch
      // shell's own redirect handle blocks renaming the live file).
      this.fd = openSync(this.logPath, mode)
      try {
        this.currentBytes = mode === 'w' ? 0 : statSync(this.logPath).size
      } catch {
        this.currentBytes = 0
      }
    } catch {
      // Cannot open the log file (permission/full disk): disable rotation and
      // let callers fall back to the original stream.
      this.failed = true
      this.fd = null
    }
  }

  /** True when the writer is usable; false means fall back to raw stderr. */
  get active(): boolean {
    return !this.failed && this.fd !== null
  }

  write(chunk: string | Uint8Array): void {
    if (!this.active || this.fd === null) {
      return
    }
    const encoded = typeof chunk === 'string' ? Buffer.from(chunk, 'utf-8') : Buffer.from(chunk)
    // Why: one pathological log write must not bypass the disk cap. Preserve
    // the newest tail because it carries the most useful failure context.
    const buf =
      encoded.length > this.maxBytes ? encoded.subarray(encoded.length - this.maxBytes) : encoded
    try {
      // Rotate BEFORE writing when the incoming write would cross the cap, so a
      // single large line still lands wholly in the fresh file.
      if (this.currentBytes > 0 && this.currentBytes + buf.length > this.maxBytes) {
        this.rotate()
      }
      writeSync(this.fd, buf)
      this.currentBytes += buf.length
    } catch {
      // A write failure must never crash the relay; disable and fall back.
      this.failed = true
      this.closeQuietly()
    }
  }

  private rotate(): void {
    if (this.fd !== null) {
      closeSync(this.fd)
      this.fd = null
    }
    let renamed = false
    try {
      // Preferred path: archive one generation. rename() replaces any existing
      // relay.log.1 atomically on POSIX; the live file is renamed (never
      // deleted) so no log window is lost, then we reopen a fresh relay.log.
      renameSync(this.logPath, this.rotatedPath)
      renamed = true
    } catch {
      // Why: on Windows the launch shell holds its own `1>relay.log` handle
      // WITHOUT FILE_SHARE_DELETE, so renaming the live file fails (EPERM/EBUSY)
      // — and a cross-device relay.log.1 would fail too. Fall back to truncating
      // relay.log in place ('w') so the size cap STILL holds and we don't churn a
      // failing rename on every subsequent line. The shell's fd keeps appending
      // at its own offset, but the truncation bounds total growth. Trade-off: no
      // archived generation on this platform/path.
    }
    // Successful rename → fresh append file (size 0). Failed rename → truncate.
    this.open(renamed ? 'a' : 'w')
  }

  private closeQuietly(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd)
      } catch {
        // best-effort
      }
      this.fd = null
    }
  }

  dispose(): void {
    this.closeQuietly()
  }
}

/**
 * Route process.stdout/stderr writes through a RotatingLogWriter that owns
 * `logPath`. Returns a restore function. If the writer cannot open the file,
 * the original streams are left untouched (logging still works, just uncapped).
 */
export function installRelayLogRotation(
  logPath: string,
  maxBytes: number = DEFAULT_RELAY_LOG_MAX_BYTES
): { writer: RotatingLogWriter; restore: () => void } {
  const writer = new RotatingLogWriter(logPath, maxBytes)
  const originalStdout = process.stdout.write.bind(process.stdout)
  const originalStderr = process.stderr.write.bind(process.stderr)

  if (!writer.active) {
    return { writer, restore: () => {} }
  }

  const wrap =
    (original: StreamWrite): StreamWrite =>
    (chunk: string | Uint8Array, encodingOrCb?: unknown, cb?: unknown): boolean => {
      writer.write(chunk)
      // Why: preserve the Writable.write callback contract so callers awaiting
      // the write (rare, but e.g. flush-before-exit) are not left hanging.
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb
      if (typeof callback === 'function') {
        ;(callback as (err?: Error | null) => void)(null)
      }
      // If the writer went inactive mid-run (write failure), fall back so logs
      // are not silently dropped for the rest of the session.
      if (!writer.active) {
        return (original as (c: string | Uint8Array) => boolean)(chunk)
      }
      return true
    }

  process.stdout.write = wrap(originalStdout as StreamWrite) as typeof process.stdout.write
  process.stderr.write = wrap(originalStderr as StreamWrite) as typeof process.stderr.write

  return {
    writer,
    restore: () => {
      process.stdout.write = originalStdout as typeof process.stdout.write
      process.stderr.write = originalStderr as typeof process.stderr.write
      writer.dispose()
    }
  }
}
