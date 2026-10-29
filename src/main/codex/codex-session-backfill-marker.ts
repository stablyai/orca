import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import {
  expandCodexSessionBackfillDatesThroughToday,
  getCodexSessionBackfillDate,
  mergeCodexSessionBackfillDates,
  parseCodexSessionBackfillDates,
  subtractCodexSessionBackfillDates
} from './codex-session-backfill-scan-dates'
import type {
  CodexSessionBackfillDate,
  CodexSessionBackfillSummary
} from './codex-session-backfill-types'

const CODEX_SESSION_BACKFILL_MARKER_VERSION = 4
// v3 certified a full walk; accept it as a baseline to avoid rescanning after upgrade.
const MARKER_BASELINE_VERSIONS: ReadonlySet<number> = new Set([3, 4])
// Use a full walk once abnormal-exit recovery exceeds this many dates.
const MAX_PENDING_SCAN_DATES = 31

let markerInvalidationGeneration = 0

export type CodexSessionBackfillBaseline = {
  /** Dates that may still contain unpublished rollouts, widened after an active launch. */
  pendingScanDates: readonly CodexSessionBackfillDate[]
}

export function captureCodexSessionBackfillMarkerGeneration(): number {
  return markerInvalidationGeneration
}

/** Certified history may still need bounded scans for pending dates. */
export function readCodexSessionBackfillBaseline(
  markerPath: string,
  systemSessionsRoot: string,
  today: CodexSessionBackfillDate = getCodexSessionBackfillDate()
): CodexSessionBackfillBaseline | null {
  const record = readMarkerRecord(markerPath)
  if (!record?.hasBaseline || !matchesTargetRoot(record, systemSessionsRoot)) {
    return null
  }
  // Previously empty sources may gain sessions and need another async scan.
  if (record.baselineScannedFiles === 0 || record.needsFullScan) {
    return null
  }
  // A pane active at completion may have written unrecorded dates before an abnormal exit.
  const pendingScanDates = record.launchActive
    ? expandCodexSessionBackfillDatesThroughToday(
        record.pendingScanDates,
        today,
        MAX_PENDING_SCAN_DATES
      )
    : record.pendingScanDates
  return pendingScanDates ? { pendingScanDates } : null
}

export function hasCompletedCodexSessionBackfillMarker(
  markerPath: string,
  systemSessionsRoot: string
): boolean {
  return readCodexSessionBackfillBaseline(markerPath, systemSessionsRoot) !== null
}

export function writeCodexSessionBackfillMarker(
  markerPath: string,
  systemSessionsRoot: string,
  summary: CodexSessionBackfillSummary,
  expectedGeneration: number,
  options: {
    /** Bounded passes can extend but cannot establish a full-history baseline. */
    coverage: 'full' | 'bounded'
    coveredScanDates: readonly CodexSessionBackfillDate[]
    /** Live panes can still write into these dates, so keep them pending. */
    retainPendingScanDates?: boolean
  }
): void {
  const record = readMarkerRecord(markerPath)
  const current = record && matchesTargetRoot(record, systemSessionsRoot) ? record : null
  // A bounded pass cannot certify history it never scanned.
  if (options.coverage !== 'full' && !current?.hasBaseline) {
    return
  }
  // A racing launch can write behind the walk; preserve its pending dates.
  const generationCurrent = expectedGeneration === markerInvalidationGeneration
  const clearCovered = generationCurrent && options.retainPendingScanDates !== true
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
    coverage: 'full',
    completedAt: Date.now(),
    launchActive: options.retainPendingScanDates === true,
    // Empty bounded scans must not erase the count from the full-history baseline.
    baselineScannedFiles:
      options.coverage === 'full' ? summary.scannedFiles : current?.baselineScannedFiles,
    summary,
    // Clear full-scan demand only if no launch overtook the full walk.
    ...describePendingScanDates(
      pendingScanDates,
      current?.needsFullScan === true && !(generationCurrent && options.coverage === 'full')
    )
  })
}

/** Retain the full-history baseline while adding dates; returns whether a full scan is owed. */
export function markCodexSessionBackfillMarkerPending(
  markerPath: string,
  systemSessionsRoot: string,
  scanDates: readonly CodexSessionBackfillDate[]
): boolean {
  // Prevent older in-flight passes from clearing these dates.
  markerInvalidationGeneration += 1
  const record = readMarkerRecord(markerPath)
  if (record && !matchesTargetRoot(record, systemSessionsRoot)) {
    return true
  }
  const pendingScanDates = mergeCodexSessionBackfillDates(record?.pendingScanDates, scanDates)
  const pending = describePendingScanDates(pendingScanDates, record?.needsFullScan === true)
  if (pendingScanDates.length === record?.pendingScanDates.length) {
    return record.needsFullScan
  }
  try {
    writeMarkerRecord(markerPath, {
      version: CODEX_SESSION_BACKFILL_MARKER_VERSION,
      systemSessionsRoot,
      coverage: 'bounded',
      // Preserve existing version/coverage, including v3's implicit full baseline.
      ...record?.raw,
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
export function markCodexSessionBackfillMarkerNeedsFullScan(markerPath: string): void {
  // Prevent older in-flight passes from clearing this demand.
  markerInvalidationGeneration += 1
  const record = readMarkerRecord(markerPath)
  // No marker already means no baseline, so the next pass walks everything.
  if (!record || record.needsFullScan) {
    return
  }
  try {
    writeMarkerRecord(markerPath, { ...record.raw, pendingScanDates: [], needsFullScan: true })
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
  launchActive: boolean
  baselineScannedFiles: number | undefined
}

function readMarkerRecord(markerPath: string): CodexSessionBackfillMarkerRecord | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(markerPath, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const marker = parsed as {
      version?: unknown
      systemSessionsRoot?: unknown
      coverage?: unknown
      pendingScanDates?: unknown
      needsFullScan?: unknown
      launchActive?: unknown
      baselineScannedFiles?: unknown
      summary?: { scannedFiles?: unknown }
    }
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
      launchActive: marker.launchActive === true,
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

// Full-scan demand must survive its originating launch or overflowed dates will never be revisited.
function describePendingScanDates(
  pendingScanDates: readonly CodexSessionBackfillDate[],
  stillOwesFullScan: boolean
): { pendingScanDates: readonly CodexSessionBackfillDate[]; needsFullScan: boolean } {
  return pendingScanDates.length > MAX_PENDING_SCAN_DATES || stillOwesFullScan
    ? { pendingScanDates: [], needsFullScan: true }
    : { pendingScanDates, needsFullScan: false }
}

function writeMarkerRecord(markerPath: string, record: Record<string, unknown>): void {
  mkdirSync(dirname(markerPath), { recursive: true })
  writeFileAtomically(markerPath, `${JSON.stringify(record, null, 2)}\n`)
}
