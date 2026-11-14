import { basename } from 'node:path/posix'
import { sanitizeCrashReportString } from '../../shared/crash-report-redaction'
import { redactString } from '../observability/redactor'

export const MAX_NATIVE_HANG_REPORT_BYTES = 2 * 1024 * 1024
export const MAX_NATIVE_HANG_ARTIFACT_BYTES = 3 * 1024 * 1024

export type NativeHangProcessMetadata = {
  appVersion: string
  electronVersion: string
  chromeVersion: string
  arch: string
  osRelease: string
  osVersion: string
}

export type NativeHangArtifact = {
  version: 1
  captureId: string
  detectedAt: number
  capturedAt: number
  pid: number
  showMenuBarIcon: boolean | null
  process: NativeHangProcessMetadata
  report: string
}

export function sanitizeNativeHangReport(text: string): string | null {
  if (
    !text.endsWith('\n') ||
    !/^OS Version:\s+.+\(.+\)/m.test(text) ||
    !/^Call graph:/m.test(text) ||
    !/^\s+\d+ Thread_\S+/m.test(text)
  ) {
    return null
  }
  const lines = text.split('\n')
  const images = lines.indexOf('Binary Images:')
  if (images === -1) {
    return null
  }
  let imageCount = 0
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (index > images && line.trim()) {
      const image =
        /^(\s*0x[\da-f]+\s+-\s+0x[\da-f]+\s+.+\s+<[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}>)\s+.+$/i.exec(
          line
        )
      if (!image) {
        return null
      }
      lines[index] = `${image[1]} [redacted-path]`
      imageCount++
    } else if (/^(?:Path|Analysis Tool):/.test(line)) {
      lines[index] = `${line.slice(0, line.indexOf(':'))}: [redacted-path]`
    } else {
      lines[index] = line.replace(
        /\(in (\/.+)\)(?=\s+(?:\+\s+\d+\s+)?\[0x[\da-f]+\])/gi,
        (_match, location: string) => `(in ${basename(location)})`
      )
      if (lines[index]!.includes('(in /')) {
        return null
      }
    }
  }
  if (!imageCount) {
    return null
  }
  // Artifact admission bounds the whole value; scalar truncation would destroy image identities.
  return redactString(sanitizeCrashReportString(lines.join('\n'), Number.MAX_SAFE_INTEGER))
}

export function parseNativeHangArtifact(value: unknown): NativeHangArtifact | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('captureId' in value) ||
    typeof value.captureId !== 'string' ||
    !('detectedAt' in value) ||
    typeof value.detectedAt !== 'number' ||
    !Number.isSafeInteger(value.detectedAt) ||
    !('capturedAt' in value) ||
    typeof value.capturedAt !== 'number' ||
    !Number.isSafeInteger(value.capturedAt) ||
    !('pid' in value) ||
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !('showMenuBarIcon' in value) ||
    (typeof value.showMenuBarIcon !== 'boolean' && value.showMenuBarIcon !== null) ||
    !('report' in value) ||
    typeof value.report !== 'string' ||
    !('process' in value) ||
    !value.process ||
    typeof value.process !== 'object'
  ) {
    return null
  }
  const metadata = value.process
  if (
    !('appVersion' in metadata) ||
    typeof metadata.appVersion !== 'string' ||
    !('electronVersion' in metadata) ||
    typeof metadata.electronVersion !== 'string' ||
    !('chromeVersion' in metadata) ||
    typeof metadata.chromeVersion !== 'string' ||
    !('arch' in metadata) ||
    typeof metadata.arch !== 'string' ||
    !('osRelease' in metadata) ||
    typeof metadata.osRelease !== 'string' ||
    !('osVersion' in metadata) ||
    typeof metadata.osVersion !== 'string'
  ) {
    return null
  }
  const report = sanitizeNativeHangReport(value.report)
  if (!report) {
    return null
  }
  return {
    version: 1,
    captureId: value.captureId,
    detectedAt: value.detectedAt,
    capturedAt: value.capturedAt,
    pid: value.pid,
    showMenuBarIcon: value.showMenuBarIcon,
    process: {
      appVersion: sanitizeCrashReportString(metadata.appVersion),
      electronVersion: sanitizeCrashReportString(metadata.electronVersion),
      chromeVersion: sanitizeCrashReportString(metadata.chromeVersion),
      arch: sanitizeCrashReportString(metadata.arch),
      osRelease: sanitizeCrashReportString(metadata.osRelease),
      osVersion: sanitizeCrashReportString(metadata.osVersion)
    },
    report
  }
}
