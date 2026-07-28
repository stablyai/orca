// Diagnostic bundle collection + upload (Mode 3, telemetry-error-tracking.md): the one
// user-initiated network path from the error-tracking lane to Orca infra. The per-bundle
// submission ID NEVER carries install_id (security-review Issue 8), and main retains the
// uploadable payload so a compromised renderer can't substitute bytes after preview.
// Server endpoint contract lives in telemetry-error-tracking.md §Endpoint contract; we
// ship only the client, with the hardening invariants it controls (content-type pinning,
// upload body-size cap, token-handling discipline).

import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { MAX_BUNDLE_BYTES } from './diagnostic-bundle-limits'
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
  const lines: string[] = [headerLine]
  let spanCount = 0
  // Track bytes incrementally to avoid an O(N²) `lines.join('\n').length` per span.
  let currentBytes = Buffer.byteLength(`${headerLine}\n`)
  const maxRecordBytes = MAX_BUNDLE_BYTES - currentBytes

  // Trace files then daemon log, each newest → oldest so the byte cap keeps the most recent spans.
  const files = [
    ...listRotatedFiles(opts.traceFilePath, opts.maxFiles),
    ...(opts.daemonLogFilePath
      ? listRotatedFiles(opts.daemonLogFilePath, opts.daemonLogMaxFiles ?? opts.maxFiles)
      : [])
  ]
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
      if (redactedBytes > maxRecordBytes) {
        // Skip a single oversized record so it can't suppress every smaller span behind it.
        continue
      }
      if (currentBytes + redactedBytes > MAX_BUNDLE_BYTES) {
        // Hard ceiling matches the upload endpoint's 4 MiB; check before appending so the preview uploads as-is.
        break outer
      }
      lines.push(redacted)
      spanCount += 1
      currentBytes += redactedBytes
    }
  }

  const payload = `${lines.join('\n')}\n`
  return {
    bundleSubmissionId,
    payload,
    bytes: Buffer.byteLength(payload),
    spanCount
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
  MAX_BUNDLE_BYTES
}
