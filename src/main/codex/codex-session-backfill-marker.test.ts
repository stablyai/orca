import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  captureCodexSessionBackfillMarkerGeneration,
  hasCompletedCodexSessionBackfillMarker,
  markCodexSessionBackfillMarkerPending,
  readCodexSessionBackfillBaseline,
  writeCodexSessionBackfillMarker
} from './codex-session-backfill-marker'
import {
  getCodexSessionBackfillDate,
  getCodexSessionBackfillDatesBetween
} from './codex-session-backfill-scan-dates'
import type {
  CodexSessionBackfillDate,
  CodexSessionBackfillSummary
} from './codex-session-backfill-types'

const WINDOWS_ROOT = 'C:\\Users\\Me\\.codex\\sessions'
const TODAY = getCodexSessionBackfillDate()
const LAUNCH_DATE: CodexSessionBackfillDate = ['2026', '08', '05']

let stateDir: string
let markerPath: string

function createSummary(scannedFiles = 3): CodexSessionBackfillSummary {
  return {
    stopped: false,
    scannedFiles,
    linkedFiles: scannedFiles,
    copiedFiles: 0,
    skippedExistingFiles: 0,
    skippedUnexpectedFiles: 0,
    skippedSymlinkFiles: 0,
    skippedUnsupportedFilesystemFiles: 0,
    failedDirectories: 0,
    failedFiles: 0,
    failedHealAuditRecords: 0
  }
}

function writeFullBaseline(
  root: string,
  options: { coveredScanDates?: readonly CodexSessionBackfillDate[]; retain?: boolean } = {}
): void {
  writeCodexSessionBackfillMarker(
    markerPath,
    root,
    createSummary(),
    captureCodexSessionBackfillMarkerGeneration(),
    {
      coverage: 'full',
      coveredScanDates: options.coveredScanDates ?? [],
      retainPendingScanDates: options.retain
    }
  )
}

/** More dates than MAX_PENDING_SCAN_DATES, so the marker gives up on bounding. */
function overflowingDates(): CodexSessionBackfillDate[] {
  return getCodexSessionBackfillDatesBetween(
    new Date(Date.UTC(2026, 6, 1)),
    new Date(Date.UTC(2026, 7, 9))
  )
}

function readMarker(): Record<string, unknown> {
  return JSON.parse(readFileSync(markerPath, 'utf-8')) as Record<string, unknown>
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'orca-codex-marker-'))
  markerPath = join(stateDir, 'backfill-complete.json')
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

describe('codex session backfill marker', () => {
  it('treats Windows spellings of one directory as the same target', () => {
    writeFullBaseline(WINDOWS_ROOT)

    for (const alias of ['C:/Users/Me/.codex/sessions', 'c:\\users\\me\\.codex\\sessions']) {
      expect(hasCompletedCodexSessionBackfillMarker(markerPath, alias)).toBe(true)
    }
    expect(
      hasCompletedCodexSessionBackfillMarker(markerPath, 'C:\\Users\\Me\\other-codex\\sessions')
    ).toBe(false)
  })

  it('reads a legacy v3 marker as a certified baseline with nothing pending', () => {
    writeFileSync(
      markerPath,
      `${JSON.stringify({
        version: 3,
        systemSessionsRoot: WINDOWS_ROOT,
        completedAt: Date.now(),
        summary: { scannedFiles: 12 }
      })}\n`,
      'utf-8'
    )

    expect(readCodexSessionBackfillBaseline(markerPath, 'c:/users/me/.codex/sessions')).toEqual({
      pendingScanDates: []
    })
  })

  it('keeps honoring the v3 empty-source guard', () => {
    writeFileSync(
      markerPath,
      `${JSON.stringify({
        version: 3,
        systemSessionsRoot: WINDOWS_ROOT,
        summary: { scannedFiles: 0 }
      })}\n`,
      'utf-8'
    )

    expect(readCodexSessionBackfillBaseline(markerPath, WINDOWS_ROOT)).toBeNull()
  })

  it('does not treat a bounded pass that scanned nothing as an empty source', () => {
    writeFullBaseline(WINDOWS_ROOT)
    writeCodexSessionBackfillMarker(
      markerPath,
      WINDOWS_ROOT,
      createSummary(0),
      captureCodexSessionBackfillMarkerGeneration(),
      { coverage: 'bounded', coveredScanDates: [LAUNCH_DATE] }
    )

    expect(readMarker()).toMatchObject({ baselineScannedFiles: 3 })
    expect(hasCompletedCodexSessionBackfillMarker(markerPath, WINDOWS_ROOT)).toBe(true)
  })

  it('refuses to let a bounded pass invent a baseline it never verified', () => {
    writeCodexSessionBackfillMarker(
      markerPath,
      WINDOWS_ROOT,
      createSummary(),
      captureCodexSessionBackfillMarkerGeneration(),
      { coverage: 'bounded', coveredScanDates: [LAUNCH_DATE] }
    )

    expect(hasCompletedCodexSessionBackfillMarker(markerPath, WINDOWS_ROOT)).toBe(false)
  })

  it('records a launch date without destroying the historical baseline', () => {
    writeFullBaseline(WINDOWS_ROOT)

    markCodexSessionBackfillMarkerPending(markerPath, 'C:/Users/Me/.codex/sessions', [LAUNCH_DATE])

    expect(readMarker()).toMatchObject({ coverage: 'full', pendingScanDates: [LAUNCH_DATE] })
    expect(readCodexSessionBackfillBaseline(markerPath, WINDOWS_ROOT)).toEqual({
      pendingScanDates: [LAUNCH_DATE]
    })
  })

  it('leaves a marker for a different history untouched', () => {
    writeFullBaseline(WINDOWS_ROOT)

    markCodexSessionBackfillMarkerPending(markerPath, 'D:\\other\\.codex\\sessions', [LAUNCH_DATE])

    expect(readMarker()).toMatchObject({ systemSessionsRoot: WINDOWS_ROOT, pendingScanDates: [] })
  })

  it('keeps a racing launch date pending when an older pass publishes', () => {
    writeFullBaseline(WINDOWS_ROOT)
    const staleGeneration = captureCodexSessionBackfillMarkerGeneration()
    markCodexSessionBackfillMarkerPending(markerPath, WINDOWS_ROOT, [LAUNCH_DATE])

    writeCodexSessionBackfillMarker(markerPath, WINDOWS_ROOT, createSummary(), staleGeneration, {
      coverage: 'bounded',
      coveredScanDates: [LAUNCH_DATE]
    })

    expect(readMarker()).toMatchObject({ pendingScanDates: [LAUNCH_DATE] })
  })

  it('keeps the pane date pending while the pane is still live', () => {
    writeFullBaseline(WINDOWS_ROOT, { coveredScanDates: [LAUNCH_DATE], retain: true })

    expect(readMarker()).toMatchObject({ launchActive: true, pendingScanDates: [LAUNCH_DATE] })
  })

  it('settles every pending date once a full walk covers them', () => {
    writeFullBaseline(WINDOWS_ROOT)
    markCodexSessionBackfillMarkerPending(markerPath, WINDOWS_ROOT, [LAUNCH_DATE])

    writeFullBaseline(WINDOWS_ROOT)

    // The walk looked at every date, so nothing is left to revisit.
    expect(readMarker()).toMatchObject({ pendingScanDates: [] })
  })

  it('demands a full walk once the pending window outgrows its bound', () => {
    writeFullBaseline(WINDOWS_ROOT)

    expect(
      markCodexSessionBackfillMarkerPending(markerPath, WINDOWS_ROOT, overflowingDates())
    ).toBe(true)

    expect(readMarker()).toMatchObject({ needsFullScan: true, pendingScanDates: [] })
    expect(hasCompletedCodexSessionBackfillMarker(markerPath, WINDOWS_ROOT)).toBe(false)
  })

  it('keeps owing that full walk when the next launch records its own date', () => {
    writeFullBaseline(WINDOWS_ROOT)
    markCodexSessionBackfillMarkerPending(markerPath, WINDOWS_ROOT, overflowingDates())

    expect(markCodexSessionBackfillMarkerPending(markerPath, WINDOWS_ROOT, [TODAY])).toBe(true)

    expect(readMarker()).toMatchObject({ needsFullScan: true, pendingScanDates: [] })
    expect(hasCompletedCodexSessionBackfillMarker(markerPath, WINDOWS_ROOT)).toBe(false)
  })

  it('keeps the full-walk demand when a later launch overtook the walk', () => {
    writeFullBaseline(WINDOWS_ROOT)
    const staleGeneration = captureCodexSessionBackfillMarkerGeneration()
    markCodexSessionBackfillMarkerPending(markerPath, WINDOWS_ROOT, overflowingDates())

    writeCodexSessionBackfillMarker(markerPath, WINDOWS_ROOT, createSummary(), staleGeneration, {
      coverage: 'full',
      coveredScanDates: []
    })

    // The walk may have passed those dates before their rollouts existed.
    expect(readMarker()).toMatchObject({ needsFullScan: true })
  })

  it('clears the full-walk demand only once a full walk certifies the tree', () => {
    writeFullBaseline(WINDOWS_ROOT)
    markCodexSessionBackfillMarkerPending(markerPath, WINDOWS_ROOT, overflowingDates())

    writeFullBaseline(WINDOWS_ROOT)

    expect(readMarker()).toMatchObject({ needsFullScan: false, pendingScanDates: [] })
    expect(hasCompletedCodexSessionBackfillMarker(markerPath, WINDOWS_ROOT)).toBe(true)
  })

  it('persists a launch date even before any baseline exists', () => {
    markCodexSessionBackfillMarkerPending(markerPath, WINDOWS_ROOT, [TODAY])

    expect(readMarker()).toMatchObject({ coverage: 'bounded', pendingScanDates: [TODAY] })
    expect(hasCompletedCodexSessionBackfillMarker(markerPath, WINDOWS_ROOT)).toBe(false)
  })
})
