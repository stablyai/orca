// Diagnostic bundle collection + upload (Mode 3 from
// telemetry-error-tracking.md). The single user-initiated network path from
// the error-tracking lane to Orca infrastructure. Every step here implements
// a hardening requirement from §Endpoint contract — the comments name the
// requirement number when they apply.
//
// Lifecycle:
//   1. `collectBundle()` — read the last N minutes of NDJSON across the
//      rotated family, run the redactor a second time over the merged
//      payload (belt-and-suspenders), embed the per-bundle
//      `bundle_submission_id`. NEVER carries `install_id` (Issue 8 in the
//      security review).
//   2. (renderer) — preview the bundle as plain text. User can copy or cancel.
//      Main retains the uploadable payload so renderer cannot substitute
//      arbitrary bytes after preview.
//   3. `uploadBundle()` — two-step:
//      a) POST `/diagnostics/token` → token + upload_url
//      b) POST `<upload_url>` with `Authorization: Bearer <token>` and the
//         collected NDJSON payload. Returns ticket ID.
//   4. (renderer) — surface the support reference ID; offer copy/delete
//      controls. Delete posts only the server-issued ID.
//
// Server-side endpoint contract is fully specified in
// telemetry-error-tracking.md §Endpoint contract. Implementation of those
// endpoints (token issuance, rate limit, storage, server-side redaction,
// retention, deletion) is operational TBD — flagged as an open question to
// the human dispatching this task. We ship the *client* of that contract
// with all hardening invariants the client controls (content-type pinning,
// body-size cap on upload, token-handling discipline).

import { randomBytes } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { MAX_BUNDLE_BYTES } from './diagnostic-bundle-limits'
import { listRotatedFiles } from './local-file-sink'
import { redactValue } from './redactor'

const DEFAULT_LOOKBACK_MINUTES = 30

export type CollectBundleOptions = {
  readonly traceFilePath: string
  readonly maxFiles: number
  readonly lookbackMinutes?: number
  readonly appVersion: string
  readonly platform: string
  readonly arch: string
  readonly osRelease: string
  readonly orcaChannel: 'stable' | 'rc' | 'dev'
}

export type CollectedBundle = {
  /** 128-bit unguessable random ID, base64url. NOT the install_id —
   *  bundles are deliberately join-incompatible with the PostHog lane. */
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
 * Read the last N minutes of NDJSON across the rotated family and produce
 * a redacted bundle payload. Caller renders this as preview text; main keeps
 * the uploadable payload and `uploadBundle()` ships only those collected
 * bytes. This keeps compromised renderer code from substituting arbitrary
 * upload content after preview.
 */
export function collectBundle(opts: CollectBundleOptions): CollectedBundle {
  const lookbackMs = (opts.lookbackMinutes ?? DEFAULT_LOOKBACK_MINUTES) * 60 * 1000
  const cutoffNanos = BigInt(Date.now() - lookbackMs) * 1_000_000n
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
  // Running byte counter for the eventual payload. Starts with the header
  // plus its final newline; each pushed span adds its line plus newline.
  // Avoids re-running `lines.join('\n').length` every iteration — that's
  // O(N²) in span count and dominates collection time for large backlogs.
  let currentBytes = Buffer.byteLength(`${headerLine}\n`)
  const maxRecordBytes = MAX_BUNDLE_BYTES - currentBytes

  // Files from listRotatedFiles are newest → oldest. Reading newest first
  // means the cutoff filter naturally bounds our work — once we hit a span
  // older than the cutoff in an older file we can stop entirely. We don't
  // optimize that yet; the worst case (10 × 10 MB = 100 MB scan) takes
  // <1 s on a modern SSD and bundles are user-initiated, not hot-path.
  const files = listRotatedFiles(opts.traceFilePath, opts.maxFiles)
  outer: for (const file of files) {
    let text: string
    try {
      // statSync first to skip absurdly-large files defensively. The sink
      // caps at 10 MB per file; a tampered file could theoretically be
      // bigger, in which case we want to abort the bundle rather than
      // panic-allocate.
      const size = statSync(file).size
      if (size > 50 * 1024 * 1024) {
        continue
      }
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }

    // NDJSON parsing — one record per line. Process each file newest-first
    // so the size cap preserves the spans closest to the support action.
    // Skip malformed lines silently; a crash can leave a half-line.
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
      const record = parsed as { startTimeUnixNano?: string; endTimeUnixNano?: string }
      // Filter by end-time, not start-time. A long-lived span started 35
      // minutes ago but ending inside the lookback is exactly what we want
      // in the bundle for diagnosing "session crashed at minute 32."
      if (typeof record.endTimeUnixNano === 'string') {
        try {
          if (BigInt(record.endTimeUnixNano) < cutoffNanos) {
            continue
          }
        } catch {
          // Non-numeric end-time — keep it; better to over-include than to
          // drop a record we couldn't classify.
        }
      }

      // Run the redactor a SECOND TIME over the parsed shape, in server mode.
      // This catches nested auth-bearing fields and strips product-telemetry
      // identity keys before the user's eyes hit the preview window.
      const redacted = JSON.stringify(redactValue(parsed, 'server'))
      const redactedBytes = Buffer.byteLength(redacted) + 1
      if (redactedBytes > maxRecordBytes) {
        // One pathological record should not suppress every smaller recent
        // span behind it. Skip records that cannot fit in an empty payload.
        continue
      }
      if (currentBytes + redactedBytes > MAX_BUNDLE_BYTES) {
        // Hard ceiling at the same 4 MiB the upload endpoint enforces.
        // Check before appending so the preview can be uploaded as-is.
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

/**
 * 128-bit cryptographic random, URL-safe base64. Generated per bundle —
 * NOT persisted. A user submitting two bundles produces two unrelated IDs.
 * This is the primary structural mitigation for Issue 8 (bundle ↔
 * install_id correlation).
 */
export function generateBundleSubmissionId(): string {
  // 16 bytes = 128 bits → base64url is 22 chars (no padding). Matches the
  // §Endpoint contract requirement that ticket IDs be unguessable and
  // non-enumerable; we use the same shape for the submission ID.
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
