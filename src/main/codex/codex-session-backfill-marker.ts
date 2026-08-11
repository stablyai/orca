import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import type { CodexSessionBackfillSummary } from './codex-session-backfill-types'

// Why: bump to re-run the backfill for every host after a layout or semantics
// change; the run itself stays skip-existing so re-runs never overwrite.
const CODEX_SESSION_BACKFILL_MARKER_VERSION = 3
let markerInvalidationGeneration = 0

export function captureCodexSessionBackfillMarkerGeneration(): number {
  return markerInvalidationGeneration
}

export function hasCompletedCodexSessionBackfillMarker(
  markerPath: string,
  systemSessionsRoot: string
): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(markerPath, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false
    }
    const marker = parsed as {
      version?: unknown
      systemSessionsRoot?: unknown
      summary?: { scannedFiles?: unknown }
    }
    // Why: changing the configured real Codex home must backfill the new
    // target instead of honoring a marker written for a different history.
    const markerMatchesTarget =
      marker.version === CODEX_SESSION_BACKFILL_MARKER_VERSION &&
      marker.systemSessionsRoot === systemSessionsRoot
    if (!markerMatchesTarget) {
      return false
    }
    // Why: an empty source can become populated after an early migration run;
    // let the incremental async walk verify it without blocking the main thread.
    return marker.summary?.scannedFiles !== 0
  } catch {
    return false
  }
}

export function writeCodexSessionBackfillMarker(
  markerPath: string,
  systemSessionsRoot: string,
  summary: CodexSessionBackfillSummary,
  expectedGeneration: number
): void {
  // Why: a launch can invalidate this pass before its delayed replacement begins.
  if (expectedGeneration !== markerInvalidationGeneration) {
    return
  }
  mkdirSync(dirname(markerPath), { recursive: true })
  writeFileAtomically(
    markerPath,
    `${JSON.stringify(
      {
        version: CODEX_SESSION_BACKFILL_MARKER_VERSION,
        systemSessionsRoot,
        completedAt: Date.now(),
        summary
      },
      null,
      2
    )}\n`
  )
}

export function invalidateCodexSessionBackfillMarker(markerPath: string): void {
  markerInvalidationGeneration += 1
  try {
    // Why: a managed-lane system-default launch can create new source
    // rollouts, so a prior one-time marker must not suppress the next opt-in.
    rmSync(markerPath, { force: true })
  } catch (error) {
    console.warn('[codex-session-backfill] Failed to invalidate completion marker:', error)
    try {
      writeFileAtomically(
        markerPath,
        `${JSON.stringify({ version: 0, invalidatedAt: Date.now() })}\n`
      )
    } catch (fallbackError) {
      throw new AggregateError(
        [error, fallbackError],
        'Failed to invalidate Codex session backfill marker'
      )
    }
  }
}
