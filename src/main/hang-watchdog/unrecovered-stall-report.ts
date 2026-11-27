import os from 'node:os'
import { app } from 'electron'
import type { CrashReportStore } from '../crash-reporting/reports/crash-report-store'
import { hangObservationUnresponsiveMs, type HangObservation } from './hang-observation-schema'

/** Files a freeze report when the previous run ended during a stall; without it Help → Report Crash has nothing from that exit. */
export async function importUnrecoveredStallReport(
  store: CrashReportStore,
  record: HangObservation
): Promise<void> {
  // Pre-stamp records cannot be attributed; a completed sample is filed by the native importer instead.
  const native = record.native
  const sampled = native?.state === 'completed' && native.exitCode === 0 && !native.timedOut
  if (!record.appVersion || (sampled && native?.reportTruncated === false)) {
    return
  }
  const sameBuild = record.appVersion === app.getVersion()
  await store.importHangReport({
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
}
