import type { CrashReportStore } from '../crash-reporting/reports/crash-report-store'
import { readPreviousNativeHangCapture } from './native-hang-capture-store'
import { unrecoveredStallImportSettled } from './previous-unrecovered-stall-import'

// Matches Help > Report Crash's reopen window, so an old capture first read today is not offered as new.
const MAX_PREVIOUS_CAPTURE_AGE_MS = 24 * 60 * 60 * 1000

export function createPreviousNativeHangReport(options: {
  store: CrashReportStore
  directory: string
  processStartedAt: number
}): { ensureImported: () => Promise<void> } {
  let importing: Promise<void> | undefined
  const prepare = async (): Promise<void> => {
    await unrecoveredStallImportSettled()
    const capture = await readPreviousNativeHangCapture(options.directory, options.processStartedAt)
    if (!capture || Date.now() - capture.artifact.detectedAt > MAX_PREVIOUS_CAPTURE_AGE_MS) {
      return
    }
    const artifact = capture.artifact
    await options.store.importHangReport({
      source: 'child',
      processType: 'main',
      reason: 'main-thread-hang',
      exitCode: null,
      appVersion: artifact.process.appVersion,
      electronVersion: artifact.process.electronVersion,
      chromeVersion: artifact.process.chromeVersion,
      platform: 'darwin',
      arch: artifact.process.arch,
      osRelease: artifact.process.osRelease,
      details: {
        captureId: artifact.captureId,
        detectedAt: new Date(artifact.detectedAt).toISOString(),
        capturedAt: new Date(artifact.capturedAt).toISOString(),
        targetPid: artifact.pid,
        osVersion: artifact.process.osVersion,
        showMenuBarIcon: artifact.showMenuBarIcon
      }
    })
  }
  return {
    ensureImported: () =>
      (importing ??= prepare()
        .catch(() => {})
        .finally(() => {
          importing = undefined
        }))
  }
}
