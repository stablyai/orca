import { describeCrashReportExitCode } from '../../shared/crash-report-exit-code'
// Type-only, so this erases at compile time and creates no import cycle.
import type { ProcessGoneCrashEvent } from './process-gone-recorder'

// Why: exit codes arrive raw on both platforms, so name the meaning on the span
// and bundles read without manual decoding. Display-only — the recorded exitCode
// stays raw. Shares the report text's decoder so the two cannot drift apart.
export function decodedExitCodeAttribute(event: ProcessGoneCrashEvent): Record<string, string> {
  const described = describeCrashReportExitCode({
    exitCode: event.exitCode,
    platform: process.platform,
    reason: event.reason
  })
  return described === null ? {} : { 'crash.exit_code_decoded': described }
}
