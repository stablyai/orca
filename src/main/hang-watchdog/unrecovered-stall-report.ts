import os from 'node:os'
import { app } from 'electron'
import type { CrashReportStore } from '../crash-reporting/reports/crash-report-store'
import { hangObservationUnresponsiveMs, type HangObservation } from './hang-observation-schema'
import {
  listNativeHangCaptures,
  nativeHangCaptureDirectory,
  readNativeHangCapture
} from './native-hang-capture-store'
import { getCanonicalUserDataPath } from '../persistence/loading-store/user-data-path'

// Same window Help > Report Crash reopens reports in; an older freeze is history, not news.
const MAX_STALL_AGE_MS = 24 * 60 * 60 * 1000

/** Files a freeze report when the previous run ended during a stall; without it Help → Report Crash has nothing from that exit. */
export async function importUnrecoveredStallReport(
  store: CrashReportStore,
  record: HangObservation,
  captureDirectory = nativeHangCaptureDirectory(getCanonicalUserDataPath())
): Promise<boolean> {
  // Pre-stamp records cannot be attributed.
  if (!record.appVersion || Date.now() - record.detectedAt > MAX_STALL_AGE_MS) {
    return false
  }
  // A saved sample for this stall is filed by the native importer, but only one that reads and validates counts.
  for (const file of await listNativeHangCaptures(captureDirectory)) {
    if (
      file.detectedAt === record.detectedAt &&
      (await readNativeHangCapture(captureDirectory, file.captureId))
    ) {
      return false
    }
  }
  const sameBuild = record.appVersion === app.getVersion()
  const filed = await store.importHangReport({
    source: 'child',
    processType: 'main',
    reason: 'main-thread-hang',
    exitCode: null,
    appVersion: record.appVersion,
    electronVersion: sameBuild ? (process.versions.electron ?? 'unknown') : 'unknown',
    chromeVersion: sameBuild ? (process.versions.chrome ?? 'unknown') : 'unknown',
    platform: process.platform,
    arch: os.arch(),
    osRelease: os.release(),
    details: {
      captureId: `stall-${record.id}`,
      detectedAt: new Date(record.detectedAt).toISOString(),
      targetPid: record.parentPid,
      endedUnresponsive: true,
      unresponsiveAtLeastMs: Math.round(hangObservationUnresponsiveMs(record)),
      tier: record.tier ?? 'hang',
      nativeCapture: record.native?.state ?? 'none'
    }
  })
  return filed !== null
}
