// Random submission IDs cannot join install_id history. Main retains the previewed payload
// so a compromised renderer cannot substitute upload bytes.

import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { MAX_BUNDLE_BYTES } from './diagnostic-bundle-limits'
import { listRotatedFiles } from './local-file-sink'
import { redactValue } from './redactor'

const DEFAULT_LOOKBACK_MINUTES = 30
/** Reserved floor; unused space returns to traces. */
const DAEMON_LOG_BUDGET_BYTES = 1024 * 1024

export type CollectBundleOptions = {
  readonly traceFilePath: string
  readonly maxFiles: number
  readonly daemonLogFilePath?: string
  readonly daemonLogMaxFiles?: number
  readonly lookbackMinutes?: number
  readonly appVersion: string
  readonly platform: string
  readonly arch: string
  readonly osRelease: string
  readonly orcaChannel: 'stable' | 'rc' | 'dev'
}

export type CollectedBundle = {
  /** Random per-bundle ID; never use install_id. */
  readonly bundleSubmissionId: string
  /** UTF-8 NDJSON header and redacted diagnostic records. */
  readonly payload: string
  readonly bytes: number
  readonly spanCount: number
}

type BundleHeader = {
  readonly bundle_submission_id: string
  readonly app_version: string
  readonly platform: string
  readonly arch: string
  readonly os_release: string
  readonly orca_channel: 'stable' | 'rc' | 'dev'
  readonly collected_at: string
  readonly schema_version: 1
}

function* readLinesNewestFirst(text: string): Iterable<string> {
  let end = text.length
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1)
    const rawLine = text.slice(start + 1, end)
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.length > 0) {
      yield line
    }
    if (start === -1) {
      break
    }
    end = start
  }
}

type RecordWindow = {
  readonly cutoffMs: number
  readonly cutoffNanos: bigint
  readonly maxRecordBytes: number
}

function collectNewestRecords(
  files: readonly string[],
  budgetBytes: number,
  recordWindow: RecordWindow
): { lines: string[]; bytes: number } {
  const lines: string[] = []
  // Incremental byte counts avoid quadratic joins.
  let bytes = 0
  for (const file of files) {
    let text: string
    try {
      // Stat before reading to bound allocation from tampered files.
      const size = statSync(file).size
      if (size > 50 * 1024 * 1024) {
        continue
      }
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }

    // Newest-first preserves recent records; crashes can leave malformed trailing lines.
    for (const raw of readLinesNewestFirst(text)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        continue
      }
      const record = parsed as {
        startTimeUnixNano?: string
        endTimeUnixNano?: string
        ts?: string
      }
      // End time retains long-lived spans that finished inside the lookback window.
      if (typeof record.endTimeUnixNano === 'string') {
        try {
          if (BigInt(record.endTimeUnixNano) < recordWindow.cutoffNanos) {
            continue
          }
        } catch {
          // Keep unclassifiable timestamps.
        }
      } else if (typeof record.ts === 'string') {
        // Keep daemon records with unclassifiable ISO timestamps.
        const tsMs = Date.parse(record.ts)
        if (Number.isFinite(tsMs) && tsMs < recordWindow.cutoffMs) {
          continue
        }
      }

      // Redact nested auth and identity fields again before preview.
      const redacted = JSON.stringify(redactValue(parsed, 'server'))
      const redactedBytes = Buffer.byteLength(redacted) + 1
      if (redactedBytes > recordWindow.maxRecordBytes) {
        // Oversized records must not suppress smaller older records.
        continue
      }
      if (bytes + redactedBytes > budgetBytes) {
        return { lines, bytes }
      }
      lines.push(redacted)
      bytes += redactedBytes
    }
  }
  return { lines, bytes }
}

function takeNewestLines(
  lines: readonly string[],
  budgetBytes: number
): { lines: string[]; bytes: number } {
  const taken: string[] = []
  let bytes = 0
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line) + 1
    if (bytes + lineBytes > budgetBytes) {
      break
    }
    taken.push(line)
    bytes += lineBytes
  }
  return { lines: taken, bytes }
}

export function collectBundle(opts: CollectBundleOptions): CollectedBundle {
  const lookbackMs = (opts.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES) * 60 * 1000
  const cutoffMs = Date.now() - lookbackMs
  const cutoffNanos = BigInt(cutoffMs) * 1_000_000n
  const bundleSubmissionId = generateBundleSubmissionId()
  const header: BundleHeader = {
    bundle_submission_id: bundleSubmissionId,
    app_version: opts.appVersion,
    platform: opts.platform,
    arch: opts.arch,
    os_release: opts.osRelease,
    orca_channel: opts.orcaChannel,
    collected_at: new Date().toISOString(),
    schema_version: 1
  }

  const headerLine = JSON.stringify({ type: 'bundle-header', ...header })
  const headerBytes = Buffer.byteLength(`${headerLine}\n`)
  const recordWindow = {
    cutoffMs,
    cutoffNanos,
    maxRecordBytes: MAX_BUNDLE_BYTES - headerBytes
  }

  // Reserve daemon space so busy traces cannot crowd out OOM diagnostics.
  const available = MAX_BUNDLE_BYTES - headerBytes
  // Collect up to the full cap, reserve the daemon floor, then return unused trace space.
  const daemonAll = opts.daemonLogFilePath
    ? collectNewestRecords(
        listRotatedFiles(opts.daemonLogFilePath, opts.daemonLogMaxFiles ?? opts.maxFiles),
        available,
        recordWindow
      )
    : { lines: [], bytes: 0 }
  const reserved = takeNewestLines(daemonAll.lines, Math.min(DAEMON_LOG_BUDGET_BYTES, available))
  const traces = collectNewestRecords(
    listRotatedFiles(opts.traceFilePath, opts.maxFiles),
    available - reserved.bytes,
    recordWindow
  )
  const daemon = takeNewestLines(daemonAll.lines, available - traces.bytes)
  const lines = [headerLine, ...traces.lines, ...daemon.lines]
  const spanCount = traces.lines.length + daemon.lines.length
  const currentBytes = headerBytes + traces.bytes + daemon.bytes

  const payload = `${lines.join('\n')}\n`
  return {
    bundleSubmissionId,
    payload,
    bytes: currentBytes,
    spanCount
  }
}

/** Generate an unpersisted ID independent of install_id. */
export function generateBundleSubmissionId(): string {
  return randomBytes(16)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export const _internalsForTests = {
  MAX_BUNDLE_BYTES,
  DAEMON_LOG_BUDGET_BYTES
}
