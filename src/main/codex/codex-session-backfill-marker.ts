import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import type {
  CodexSessionBackfillDate,
  CodexSessionBackfillSummary
} from './codex-session-backfill-types'

const CODEX_SESSION_BACKFILL_MARKER_VERSION = 4
const MAX_PENDING_RECOVERY_DAYS = 366
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000
let markerInvalidationGeneration = 0

type CodexSessionBackfillMarker = {
  version: 4
  systemSessionsRoot: string
  baseline?: {
    completedAt: number
    summary: CodexSessionBackfillSummary
  }
  pendingSince?: string
}

export type CodexSessionBackfillMarkerStatus = {
  hasBaseline: boolean
  pendingSince?: CodexSessionBackfillDate
}

export function captureCodexSessionBackfillMarkerGeneration(): number {
  return markerInvalidationGeneration
}

export function readCodexSessionBackfillMarkerStatus(
  markerPath: string,
  systemSessionsRoot: string
): CodexSessionBackfillMarkerStatus {
  const marker = readCompatibleMarker(markerPath, systemSessionsRoot)
  return {
    hasBaseline: marker?.baseline !== undefined,
    pendingSince: parseBackfillDate(marker?.pendingSince)
  }
}

export function hasCompletedCodexSessionBackfillMarker(
  markerPath: string,
  systemSessionsRoot: string
): boolean {
  return readCodexSessionBackfillMarkerStatus(markerPath, systemSessionsRoot).hasBaseline
}

export function markCodexSessionBackfillPending(
  markerPath: string,
  systemSessionsRoot: string,
  pendingDate: CodexSessionBackfillDate
): boolean {
  markerInvalidationGeneration += 1
  const marker = readCompatibleMarker(markerPath, systemSessionsRoot) ?? {
    version: CODEX_SESSION_BACKFILL_MARKER_VERSION,
    systemSessionsRoot
  }
  const pendingSince = formatBackfillDate(pendingDate)
  marker.pendingSince =
    marker.pendingSince && marker.pendingSince < pendingSince ? marker.pendingSince : pendingSince
  writeMarker(markerPath, marker)
  return marker.baseline === undefined
}

export function writeCodexSessionBackfillMarker(
  markerPath: string,
  systemSessionsRoot: string,
  summary: CodexSessionBackfillSummary,
  expectedGeneration: number,
  options: { bounded: boolean; preservePending: boolean }
): void {
  if (expectedGeneration !== markerInvalidationGeneration) {
    return
  }
  const current = readCompatibleMarker(markerPath, systemSessionsRoot)
  if (options.bounded && !current?.baseline) {
    return
  }
  const marker: CodexSessionBackfillMarker = {
    version: CODEX_SESSION_BACKFILL_MARKER_VERSION,
    systemSessionsRoot,
    baseline: options.bounded
      ? current!.baseline
      : {
          completedAt: Date.now(),
          summary
        }
  }
  if (options.preservePending && current?.pendingSince) {
    marker.pendingSince = current.pendingSince
  }
  writeMarker(markerPath, marker)
}

export function invalidateCodexSessionBackfillMarker(markerPath: string): void {
  markerInvalidationGeneration += 1
  try {
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

function readCompatibleMarker(
  markerPath: string,
  systemSessionsRoot: string
): CodexSessionBackfillMarker | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(markerPath, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    const marker = parsed as Record<string, unknown>
    if (marker.systemSessionsRoot !== systemSessionsRoot) {
      return null
    }
    if (marker.version === CODEX_SESSION_BACKFILL_MARKER_VERSION) {
      return parseVersionFourMarker(marker, systemSessionsRoot)
    }
    if (marker.version === 3) {
      const summary = parseSummary(marker.summary)
      const migrated: CodexSessionBackfillMarker = {
        version: CODEX_SESSION_BACKFILL_MARKER_VERSION,
        systemSessionsRoot,
        ...(summary && summary.scannedFiles !== 0
          ? { baseline: { completedAt: readNumber(marker.completedAt) ?? Date.now(), summary } }
          : {})
      }
      writeMarker(markerPath, migrated)
      return migrated
    }
    return null
  } catch {
    return null
  }
}

function parseVersionFourMarker(
  marker: Record<string, unknown>,
  systemSessionsRoot: string
): CodexSessionBackfillMarker | null {
  const parsed: CodexSessionBackfillMarker = {
    version: CODEX_SESSION_BACKFILL_MARKER_VERSION,
    systemSessionsRoot
  }
  if (marker.baseline && typeof marker.baseline === 'object' && !Array.isArray(marker.baseline)) {
    const baseline = marker.baseline as Record<string, unknown>
    const summary = parseSummary(baseline.summary)
    const completedAt = readNumber(baseline.completedAt)
    if (summary && completedAt !== null) {
      parsed.baseline = { completedAt, summary }
    }
  }
  if (marker.pendingSince !== undefined) {
    const pendingSince = parseBackfillDate(marker.pendingSince)
    if (!pendingSince) {
      return null
    }
    parsed.pendingSince = formatBackfillDate(pendingSince)
  }
  return parsed
}

function parseSummary(value: unknown): CodexSessionBackfillSummary | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const summary = value as Partial<CodexSessionBackfillSummary>
  return typeof summary.scannedFiles === 'number' ? (summary as CodexSessionBackfillSummary) : null
}

function parseBackfillDate(value: unknown): CodexSessionBackfillDate | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) {
    return undefined
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const candidate = new Date(0)
  candidate.setUTCFullYear(year, month - 1, day)
  candidate.setUTCHours(0, 0, 0, 0)
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() !== month - 1 ||
    candidate.getUTCDate() !== day
  ) {
    return undefined
  }
  const now = new Date()
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const age = today - candidate.getTime()
  if (age < 0 || age > MAX_PENDING_RECOVERY_DAYS * MILLISECONDS_PER_DAY) {
    return undefined
  }
  return [match[1], match[2], match[3]]
}

function formatBackfillDate(date: CodexSessionBackfillDate): string {
  return date.join('-')
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function writeMarker(markerPath: string, marker: CodexSessionBackfillMarker): void {
  mkdirSync(dirname(markerPath), { recursive: true })
  writeFileAtomically(markerPath, `${JSON.stringify(marker, null, 2)}\n`)
}
