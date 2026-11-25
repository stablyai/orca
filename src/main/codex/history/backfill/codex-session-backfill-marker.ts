import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../../../shared/file-access/cross-platform-path'
import { writeFileAtomically } from '../../../filesystem/atomic-file-publication'
import {
  isCodexSessionBackfillDate,
  mergeCodexSessionBackfillDates,
  parseCodexSessionBackfillDates,
  subtractCodexSessionBackfillDates
} from './codex-session-backfill-scan-dates'
import type {
  CodexSessionBackfillDate,
  CodexSessionBackfillScanProgress,
  CodexSessionBackfillSummary
} from './codex-session-backfill-types'

const CODEX_SESSION_BACKFILL_MARKER_VERSION = 4
// v3 certified a full walk; accept it as a baseline to avoid rescanning after upgrade.
const MARKER_BASELINE_VERSIONS: ReadonlySet<number> = new Set([3, 4])

let markerInvalidationGeneration = 0

export type CodexSessionBackfillBaseline = {
  hasBaseline: boolean
  scanFrom?: CodexSessionBackfillDate
  scanCursor?: readonly string[]
  scanCursorFrom?: CodexSessionBackfillDate
  scanCheckpoint?: CodexSessionBackfillDate
  needsScan: boolean
  /** Legacy pending dates remain inclusive lower bounds. */
  pendingScanDates: readonly CodexSessionBackfillDate[]
}

export function captureCodexSessionBackfillMarkerGeneration(): number {
  return markerInvalidationGeneration
}

/** Certified history may still need bounded scans for pending dates. */
export function readCodexSessionBackfillBaseline(
  markerPath: string,
  systemSessionsRoot: string
): CodexSessionBackfillBaseline | null {
  const record = readMarkerRecord(markerPath)
  if (!record || !matchesTargetRoot(record, systemSessionsRoot)) {
    return null
  }
  // Previously empty sources may gain sessions and need another async scan.
  if (record.baselineScannedFiles === 0 && !record.scanCursor && !record.launchActive) {
    return null
  }
  return {
    hasBaseline: record.hasBaseline && !record.needsFullScan,
    pendingScanDates: record.pendingScanDates,
    scanFrom: record.scanFrom,
    scanCursor: record.scanCursor,
    scanCursorFrom: record.scanCursorFrom,
    scanCheckpoint: record.scanCheckpoint,
    needsScan:
      record.needsFullScan ||
      record.launchActive ||
      record.pendingScanDates.length > 0 ||
      !!record.scanCursor
  }
}

export function hasCompletedCodexSessionBackfillMarker(
  markerPath: string,
  systemSessionsRoot: string
): boolean {
  return readCodexSessionBackfillBaseline(markerPath, systemSessionsRoot)?.hasBaseline === true
}

export function writeCodexSessionBackfillMarker(
  markerPath: string,
  systemSessionsRoot: string,
  summary: CodexSessionBackfillSummary,
  expectedGeneration: number,
  options: {
    /** Full coverage requires reaching the end of an unrestricted history traversal. */
    coverage: 'full' | 'bounded'
    coveredScanDates: readonly CodexSessionBackfillDate[]
    progress: CodexSessionBackfillScanProgress
    resumed: boolean
    scanFrom?: CodexSessionBackfillDate
    /** Live panes can still write into these dates, so keep them pending. */
    retainPendingScanDates?: boolean
  }
): void {
  const record = readMarkerRecord(markerPath)
  const current = record && matchesTargetRoot(record, systemSessionsRoot) ? record : null
  const fullCoverage = options.coverage === 'full' || current?.hasBaseline === true
  // A racing launch can write behind the walk; preserve its pending dates.
  const generationCurrent = expectedGeneration === markerInvalidationGeneration
  const replayFullScan =
    generationCurrent && options.coverage === 'full' && current?.fullScanReplayRequired === true
  const clearCovered =
    generationCurrent && !options.progress.truncated && options.retainPendingScanDates !== true
  const currentPendingScanDates = current?.pendingScanDates ?? []
  const coveredScanDates =
    options.coverage === 'full' ? currentPendingScanDates : options.coveredScanDates
  const pendingScanDates = clearCovered
    ? subtractCodexSessionBackfillDates(currentPendingScanDates, coveredScanDates)
    : mergeCodexSessionBackfillDates(currentPendingScanDates, options.coveredScanDates)
  writeMarkerRecord(markerPath, {
    ...current?.raw,
    version: CODEX_SESSION_BACKFILL_MARKER_VERSION,
    systemSessionsRoot,
    // Records the retained full-history baseline, including after a bounded pass.
    coverage: fullCoverage ? 'full' : 'bounded',
    completedAt: Date.now(),
    launchActive: !clearCovered || options.resumed || replayFullScan,
    scanFrom:
      generationCurrent && !options.progress.truncated
        ? options.resumed
          ? current?.scanCheckpoint
          : (options.progress.recentDates.at(-1) ?? current?.scanFrom)
        : current?.scanFrom,
    scanCheckpoint: generationCurrent
      ? options.progress.truncated
        ? (current?.scanCheckpoint ?? options.progress.recentDates.at(-1))
        : undefined
      : current?.scanCheckpoint,
    scanCursor: generationCurrent ? options.progress.cursor : current?.scanCursor,
    scanCursorFrom: generationCurrent
      ? options.progress.truncated
        ? options.scanFrom
        : undefined
      : current?.scanCursorFrom,
    fullScanReplayRequired:
      generationCurrent && options.coverage === 'full' ? false : current?.fullScanReplayRequired,
    // Empty bounded scans must not erase the count from the full-history baseline.
    baselineScannedFiles:
      options.coverage === 'full' ? summary.scannedFiles : current?.baselineScannedFiles,
    summary,
    // Clear full-scan demand only if no launch overtook the full walk.
    ...describePendingScanDates(
      pendingScanDates,
      current?.needsFullScan === true &&
        !(generationCurrent && options.coverage === 'full' && !replayFullScan)
    )
  })
}

/** Retain the full-history baseline while adding dates; returns whether a full scan is owed. */
export function markCodexSessionBackfillMarkerPending(
  markerPath: string,
  systemSessionsRoot: string,
  scanDates: readonly CodexSessionBackfillDate[] = []
): boolean {
  // Prevent older in-flight passes from clearing these dates.
  markerInvalidationGeneration += 1
  const record = readMarkerRecord(markerPath)
  if (record && !matchesTargetRoot(record, systemSessionsRoot)) {
    return true
  }
  const pendingScanDates = mergeCodexSessionBackfillDates(record?.pendingScanDates, scanDates)
  const pending = describePendingScanDates(pendingScanDates, record?.needsFullScan === true)
  if (pendingScanDates.length === record?.pendingScanDates.length && record.launchActive) {
    return record.needsFullScan
  }
  try {
    writeMarkerRecord(markerPath, {
      version: CODEX_SESSION_BACKFILL_MARKER_VERSION,
      systemSessionsRoot,
      coverage: 'bounded',
      // Preserve existing version/coverage, including v3's implicit full baseline.
      ...record?.raw,
      launchActive: true,
      ...pending
    })
  } catch (error) {
    console.warn('[codex-session-backfill] Failed to record pending scan dates:', error)
    try {
      // Force a full rescan rather than lose an unrecorded launch date.
      rmSync(markerPath, { force: true })
    } catch (fallbackError) {
      throw new AggregateError(
        [error, fallbackError],
        'Failed to record pending Codex session backfill scan dates'
      )
    }
    return true
  }
  return pending.needsFullScan
}

/** Owe a full walk for launches whose rollout dates could not be recorded. */
export function markCodexSessionBackfillMarkerNeedsFullScan(
  markerPath: string,
  newFullScanRequest = false
): void {
  // Prevent older in-flight passes from clearing this demand.
  markerInvalidationGeneration += 1
  const record = readMarkerRecord(markerPath)
  // No marker already means no baseline, so the next pass walks everything.
  if (!record) {
    return
  }
  if (record.needsFullScan && (!newFullScanRequest || record.fullScanReplayRequired)) {
    return
  }
  try {
    writeMarkerRecord(markerPath, {
      ...record.raw,
      pendingScanDates: [],
      needsFullScan: true,
      // New demand replays the prefix after the owed tail, preserving tail progress.
      fullScanReplayRequired: record.needsFullScan && newFullScanRequest,
      scanCursor: record.needsFullScan ? record.scanCursor : undefined,
      scanCursorFrom: record.needsFullScan ? record.scanCursorFrom : undefined,
      scanCheckpoint: record.needsFullScan ? record.scanCheckpoint : undefined
    })
  } catch (error) {
    console.warn('[codex-session-backfill] Failed to record full-scan demand:', error)
    rmSync(markerPath, { force: true })
  }
}

type CodexSessionBackfillMarkerRecord = {
  raw: Record<string, unknown>
  systemSessionsRoot: string
  hasBaseline: boolean
  pendingScanDates: CodexSessionBackfillDate[]
  needsFullScan: boolean
  fullScanReplayRequired: boolean
  launchActive: boolean
  scanFrom?: CodexSessionBackfillDate
  scanCursor?: readonly string[]
  scanCursorFrom?: CodexSessionBackfillDate
  scanCheckpoint?: CodexSessionBackfillDate
  baselineScannedFiles: number | undefined
}

function readMarkerRecord(markerPath: string): CodexSessionBackfillMarkerRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(markerPath, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const marker: {
      version?: unknown
      systemSessionsRoot?: unknown
      coverage?: unknown
      pendingScanDates?: unknown
      needsFullScan?: unknown
      fullScanReplayRequired?: unknown
      scanFrom?: unknown
      scanCheckpoint?: unknown
      scanCursorFrom?: unknown
      scanCursor?: unknown
      launchActive?: unknown
      baselineScannedFiles?: unknown
      summary?: { scannedFiles?: unknown }
    } = parsed
    if (
      typeof marker.version !== 'number' ||
      !MARKER_BASELINE_VERSIONS.has(marker.version) ||
      typeof marker.systemSessionsRoot !== 'string'
    ) {
      return null
    }
    const baselineScannedFiles = marker.baselineScannedFiles ?? marker.summary?.scannedFiles
    return {
      raw: parsed as Record<string, unknown>,
      systemSessionsRoot: marker.systemSessionsRoot,
      // v3 has an implicit full-history baseline.
      hasBaseline: marker.version === 3 || marker.coverage === 'full',
      pendingScanDates: parseCodexSessionBackfillDates(marker.pendingScanDates),
      needsFullScan: marker.needsFullScan === true,
      fullScanReplayRequired: marker.fullScanReplayRequired === true,
      launchActive: marker.launchActive === true,
      scanFrom: isCodexSessionBackfillDate(marker.scanFrom) ? marker.scanFrom : undefined,
      scanCursorFrom: isCodexSessionBackfillDate(marker.scanCursorFrom)
        ? marker.scanCursorFrom
        : undefined,
      scanCheckpoint: isCodexSessionBackfillDate(marker.scanCheckpoint)
        ? marker.scanCheckpoint
        : undefined,
      scanCursor:
        Array.isArray(marker.scanCursor) &&
        marker.scanCursor.length <= 3 &&
        marker.scanCursor.every(
          (part, index) =>
            typeof part === 'string' && (index === 0 ? /^\d{4}$/ : /^\d{2}$/).test(part)
        )
          ? marker.scanCursor
          : undefined,
      baselineScannedFiles:
        typeof baselineScannedFiles === 'number' ? baselineScannedFiles : undefined
    }
  } catch {
    return null
  }
}

// Target changes require recertification; normalize Windows aliases of the same directory.
function matchesTargetRoot(
  record: CodexSessionBackfillMarkerRecord,
  systemSessionsRoot: string
): boolean {
  return (
    normalizeRuntimePathForComparison(record.systemSessionsRoot) ===
    normalizeRuntimePathForComparison(systemSessionsRoot)
  )
}

// Preserve legacy full-scan demand while compacting pending dates to their inclusive floor.
function describePendingScanDates(
  pendingScanDates: readonly CodexSessionBackfillDate[],
  stillOwesFullScan: boolean
): { pendingScanDates: readonly CodexSessionBackfillDate[]; needsFullScan: boolean } {
  return { pendingScanDates: pendingScanDates.slice(0, 1), needsFullScan: stillOwesFullScan }
}

function writeMarkerRecord(markerPath: string, record: Record<string, unknown>): void {
  mkdirSync(dirname(markerPath), { recursive: true })
  writeFileAtomically(markerPath, `${JSON.stringify(record, null, 2)}\n`)
}
