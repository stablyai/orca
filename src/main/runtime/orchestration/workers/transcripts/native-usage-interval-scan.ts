import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs'

export const NATIVE_USAGE_INTERVAL_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex', 'omp'])
const MAX_SCAN_BYTES = 64 * 1024 * 1024
const CHUNK_BYTES = 1024 * 1024

export type NativeTranscriptFileIdentity = { dev: number; ino: number; birthtimeMs: number }

export type NativeUsageIntervalUnavailableReason =
  | 'start_boundary_missing'
  | 'host_not_local'
  | 'agent_unsupported'
  | 'transcript_unreadable'
  | 'transcript_replaced'
  | 'transcript_too_large'
  | 'not_fresh_session'
  | 'session_changed'
  | 'session_shared'

export type NativeUsageIntervalScan =
  | {
      status: 'closed'
      file: NativeTranscriptFileIdentity
      startOffset: 0
      endOffset: number
      /** SHA-256 of bytes [0, endOffset) so a consumer detects any later rewrite. */
      sha256: string
    }
  | { status: 'unavailable'; reason: NativeUsageIntervalUnavailableReason }

export function nativeTranscriptFileIdentity(path: string): NativeTranscriptFileIdentity | null {
  try {
    const stat = statSync(path)
    return { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs }
  } catch {
    return null
  }
}

function recordTimestampMs(line: string): number | null | 'invalid' {
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    return 'invalid'
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return 'invalid'
  }
  const stamp = 'timestamp' in record ? record.timestamp : undefined
  if (stamp === undefined) {
    return null
  }
  const ms =
    typeof stamp === 'number' ? stamp : typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN
  return Number.isFinite(ms) ? ms : 'invalid'
}

/**
 * Prove the file was born under this launch and holds only post-launch records, so byte 0 is an
 * exact start boundary; the end is the last complete line present now. Local files only.
 */
export function scanFreshNativeTranscript(args: {
  path: string
  sessionId: string
  notBeforeMs: number
  startFile: NativeTranscriptFileIdentity | null
}): NativeUsageIntervalScan {
  if (!basename(args.path).includes(args.sessionId)) {
    return { status: 'unavailable', reason: 'not_fresh_session' }
  }
  let fd: number | undefined
  try {
    fd = openSync(args.path, 'r')
    const stat = fstatSync(fd)
    const file = { dev: stat.dev, ino: stat.ino, birthtimeMs: stat.birthtimeMs }
    if (
      args.startFile &&
      (args.startFile.dev !== file.dev ||
        args.startFile.ino !== file.ino ||
        args.startFile.birthtimeMs !== file.birthtimeMs)
    ) {
      return { status: 'unavailable', reason: 'transcript_replaced' }
    }
    // A zero birthtime means the filesystem cannot prove creation order.
    if (!(file.birthtimeMs > 0) || file.birthtimeMs < args.notBeforeMs) {
      return { status: 'unavailable', reason: 'not_fresh_session' }
    }
    if (stat.size > MAX_SCAN_BYTES) {
      return { status: 'unavailable', reason: 'transcript_too_large' }
    }
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES)
    let pending = ''
    let endOffset = 0
    let position = 0
    while (position < stat.size) {
      const read = readSync(fd, buffer, 0, Math.min(CHUNK_BYTES, stat.size - position), position)
      if (read === 0) {
        break
      }
      const chunk = buffer.subarray(0, read)
      const lastNewline = chunk.lastIndexOf(0x0a)
      if (lastNewline !== -1) {
        const complete = chunk.subarray(0, lastNewline + 1)
        hash.update(complete)
        const lines = (pending + complete.toString('utf8')).split('\n')
        pending = ''
        for (const line of lines) {
          if (!line.trim()) {
            continue
          }
          const ts = recordTimestampMs(line)
          if (ts === 'invalid' || (ts !== null && ts < args.notBeforeMs)) {
            return { status: 'unavailable', reason: 'not_fresh_session' }
          }
        }
        endOffset = position + lastNewline + 1
        pending = chunk.subarray(lastNewline + 1).toString('utf8')
      } else {
        pending += chunk.toString('utf8')
      }
      position += read
    }
    return { status: 'closed', file, startOffset: 0, endOffset, sha256: hash.digest('hex') }
  } catch {
    return { status: 'unavailable', reason: 'transcript_unreadable' }
  } finally {
    if (fd !== undefined) {
      closeSync(fd)
    }
  }
}
