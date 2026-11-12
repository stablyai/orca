import type { CrashReportRecord } from '../../shared/crash-reporting'
import type { CrashReportStore } from '../crash-reporting/reports/crash-report-store'
import {
  claimNativeHangCapture,
  readNativeHangCapture,
  readPreviousNativeHangCapture
} from './native-hang-capture-store'

export function createPreviousNativeHangReport(options: {
  store: CrashReportStore
  directory: string
  processStartedAt: number
}): { getAutomatic: () => Promise<CrashReportRecord | null>; ensureImported: () => Promise<void> } {
  let prepared: Promise<CrashReportRecord | null> | undefined
  let delivered = false
  const prepare = async (): Promise<CrashReportRecord | null> => {
    const reports = await options.store.listRecent()
    const pendingCrash = reports.find(
      (report) => report.status === 'pending' && report.reason !== 'main-thread-hang'
    )
    if (pendingCrash) {
      return null
    }
    for (const report of reports) {
      if (
        report.reason !== 'main-thread-hang' ||
        report.status !== 'pending' ||
        typeof report.details.captureId !== 'string'
      ) {
        continue
      }
      const capture = await readNativeHangCapture(options.directory, report.details.captureId)
      if (
        capture &&
        capture.state !== '.recovered' &&
        capture.artifact.detectedAt < options.processStartedAt
      ) {
        return options.store.claimHangPrompt({
          existingReportId: report.id,
          claim: () =>
            capture.state === '.seen'
              ? Promise.resolve(true)
              : claimNativeHangCapture(
                  options.directory,
                  capture.artifact.captureId,
                  options.processStartedAt
                )
        })
      }
    }
    const capture = await readPreviousNativeHangCapture(options.directory, options.processStartedAt)
    if (!capture) {
      return null
    }
    const artifact = capture.artifact
    return options.store.claimHangPrompt({
      claim: () =>
        claimNativeHangCapture(options.directory, artifact.captureId, options.processStartedAt),
      input: {
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
      }
    })
  }
  const ensure = (): Promise<CrashReportRecord | null> => (prepared ??= prepare().catch(() => null))
  return {
    ensureImported: async () => {
      await ensure()
    },
    getAutomatic: async () => {
      const report = await ensure()
      if (report?.reason !== 'main-thread-hang') {
        return null
      }
      if (delivered) {
        return null
      }
      delivered = true
      return report
    }
  }
}
