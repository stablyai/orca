import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import type { CodexSessionBackfillSummary } from './codex-session-backfill-types'

// Why: bump to re-run the backfill for every host after a layout or semantics
// change; the run itself stays skip-existing so re-runs never overwrite.
const CODEX_SESSION_BACKFILL_MARKER_VERSION = 3

export function hasCompletedCodexSessionBackfillMarker(
  markerPath: string,
  systemSessionsRoot: string
): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(markerPath, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false
    }
    const marker = parsed as { version?: unknown; systemSessionsRoot?: unknown }
    // Why: changing the configured real Codex home must backfill the new
    // target instead of honoring a marker written for a different history.
    return (
      marker.version === CODEX_SESSION_BACKFILL_MARKER_VERSION &&
      marker.systemSessionsRoot === systemSessionsRoot
    )
  } catch {
    return false
  }
}

export function writeCodexSessionBackfillMarker(
  markerPath: string,
  systemSessionsRoot: string,
  summary: CodexSessionBackfillSummary
): void {
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
  try {
    // Why: a managed-lane system-default launch can create new source
    // rollouts, so a prior one-time marker must not suppress the next opt-in.
    rmSync(markerPath, { force: true })
  } catch (error) {
    console.warn('[codex-session-backfill] Failed to invalidate completion marker:', error)
  }
}
