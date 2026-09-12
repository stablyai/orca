// Diagnostic bundle collection + upload (Mode 3, telemetry-error-tracking.md): the one
// user-initiated network path from the error-tracking lane to Orca infra. The per-bundle
// submission ID NEVER carries install_id (security-review Issue 8), and main retains the
// uploadable payload so a compromised renderer can't substitute bytes after preview.
// Server endpoint contract lives in telemetry-error-tracking.md §Endpoint contract; we
// ship only the client, with the hardening invariants it controls (content-type pinning,
// upload body-size cap, token-handling discipline).

import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { DAEMON_LOG_RESERVE_BYTES, MAX_BUNDLE_BYTES } from './diagnostic-bundle-limits'
import { listRotatedFiles } from './local-file-sink'
import { redactValue } from './redactor'

const DEFAULT_LOOKBACK_MINUTES = 30

export type CollectBundleOptions = {
  readonly traceFilePath: string
  readonly maxFiles: number
  /** Detached-daemon lifecycle log; its rotated family is merged in so daemon failures are diagnosable from a field report. */
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
  /** 128-bit unguessable base64url ID. NOT the install_id — bundles are join-incompatible with the PostHog lane. */
  readonly bundleSubmissionId: string
  /** UTF-8 NDJSON payload — header line + N redacted span lines. */
  readonly payload: string
  /** Byte length of `payload`. Pre-checked against the 4 MiB upload cap. */
  readonly bytes: number
  /** Span-line count, for the preview window's "N spans" label. */
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

type FamilyLines = {
  readonly lines: string[]
  readonly bytes: number
  readonly spanCount: number
}

/** More lifecycle lines wins; equal lines fall back to more bytes. */
function isRicherFamily(candidate: FamilyLines, incumbent: FamilyLines): boolean {
  return candidate.lines.length === incumbent.lines.length
    ? candidate.bytes >= incumbent.bytes
    : candidate.lines.length > incumbent.lines.length
}

/** Collect one rotated family newest → oldest, adding at most `budget` bytes. */
function collectFamilyLines(
  files: readonly string[],
  budget: number,
  cutoffMs: number,
  cutoffNanos: bigint
): FamilyLines {
  const lines: string[] = []
  let bytes = 0
  let spanCount = 0
  if (budget <= 0) {
    return { lines, bytes, spanCount }
  }

  outer: for (const file of files) {
    let text: string
    try {
      // stat first: the sink caps at 10 MB/file, so a tampered oversize file could panic-allocate on read.
      const size = statSync(file).size
      if (size > 50 * 1024 * 1024) {
        continue
      }
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }

    // Newest-first so the size cap preserves the most recent spans; skip malformed lines (a crash can leave a half-line).
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
      // Filter by end-time, not start-time, so long-lived spans that ended inside the lookback are still included.
      if (typeof record.endTimeUnixNano === 'string') {
        try {
          if (BigInt(record.endTimeUnixNano) < cutoffNanos) {
            continue
          }
        } catch {
          // Non-numeric end-time: keep it — better to over-include than drop an unclassifiable record.
        }
      } else if (typeof record.ts === 'string') {
        // Daemon lifecycle lines use an ISO `ts`; unparseable timestamps are kept (over-include).
        const tsMs = Date.parse(record.ts)
        if (Number.isFinite(tsMs) && tsMs < cutoffMs) {
          continue
        }
      }

      // Second redaction pass (server mode) catches nested auth fields and strips identity keys before preview.
      const redacted = JSON.stringify(redactValue(parsed, 'server'))
      const redactedBytes = Buffer.byteLength(redacted) + 1
      if (redactedBytes > budget) {
        // Skip a single oversized record so it can't suppress every smaller span behind it.
        continue
      }
      if (bytes + redactedBytes > budget) {
        // This family is full; the caller's remaining budget still covers the other family.
        break outer
      }
      lines.push(redacted)
      spanCount += 1
      bytes += redactedBytes
    }
  }

  return { lines, bytes, spanCount }
}

/**
 * Read the last N minutes of NDJSON across the rotated family into a redacted bundle payload.
 * Main keeps the uploadable payload so a compromised renderer can't substitute bytes after preview.
 */
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
  const available = MAX_BUNDLE_BYTES - Buffer.byteLength(`${headerLine}\n`)

  const daemonFiles = opts.daemonLogFilePath
    ? listRotatedFiles(opts.daemonLogFilePath, opts.daemonLogMaxFiles ?? opts.maxFiles)
    : []

  // Daemon family first, under a small reserve: it is tiny and high-value, and a trace family
  // that fills the whole cap would otherwise starve it to zero lines.
  const reserve = Math.min(DAEMON_LOG_RESERVE_BYTES, available)
  const reserved = collectFamilyLines(daemonFiles, reserve, cutoffMs, cutoffNanos)
  // Trace gets every reserved byte the daemon log did not use.
  const trace = collectFamilyLines(
    listRotatedFiles(opts.traceFilePath, opts.maxFiles),
    available - reserved.bytes,
    cutoffMs,
    cutoffNanos
  )
  // Why a second daemon pass: the reserve is a floor, not a ceiling. A light trace family would
  // otherwise leave megabytes of cap unspent while a busy daemon log was cut off at the reserve.
  const daemonBudget = available - trace.bytes
  const rerun =
    daemonBudget > reserved.bytes
      ? collectFamilyLines(daemonFiles, daemonBudget, cutoffMs, cutoffNanos)
      : reserved
  // Why keep the better pass: collection is not monotonic in budget. A record the reserve pass
  // skipped as oversized can be admitted by the larger budget and then fill it, cutting off
  // everything behind it — and a daemon rotation between the two reads has the same effect.
  // Lines rank above bytes: the daemon log's value is the sequence of lifecycle events, so four
  // events beat one blob that happens to weigh more.
  const daemon = isRicherFamily(rerun, reserved) ? rerun : reserved

  // Emitted trace-then-daemon, each family newest → oldest within itself.
  const payload = `${[headerLine, ...trace.lines, ...daemon.lines].join('\n')}\n`
  return {
    bundleSubmissionId,
    payload,
    bytes: Buffer.byteLength(payload),
    spanCount: trace.spanCount + daemon.spanCount
  }
}

// ── Bundle submission ID ─────────────────────────────────────────────────

/** 128-bit URL-safe-base64 random, per-bundle and NOT persisted — mitigation for Issue 8 (bundle ↔ install_id correlation). */
export function generateBundleSubmissionId(): string {
  // 16 bytes = 128 bits, base64url = 22 chars; unguessable/non-enumerable per §Endpoint contract.
  return randomBytes(16)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// Test-only export.
export const _internalsForTests = {
  DAEMON_LOG_RESERVE_BYTES,
  MAX_BUNDLE_BYTES
}
