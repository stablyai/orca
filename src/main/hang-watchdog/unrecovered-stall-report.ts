import os from 'node:os'
import { app } from 'electron'
import type { CrashReportStore } from '../crash-reporting/reports/crash-report-store'
import { hangObservationUnresponsiveMs, type HangObservation } from './hang-observation-schema'

/** Files a freeze report when the previous run ended during a stall; without it Help → Report Crash has nothing from that exit. */
export async function importUnrecoveredStallReport(
  store: CrashReportStore,
  record: HangObservation
): Promise<void> {
  // Records from builds that predate the version stamp cannot be attributed safely.
  if (!record.appVersion) {
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
      nativeCapture: record.native ? 'partial' : 'none'
    }
  })
}
