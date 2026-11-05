import { runAfterFirstWindowShown } from '../startup/first-window-deferral'
import { reportSecretProtectionGap } from './secret-protection-report'

/** Defer diagnostic keyring probes: locked Linux keyrings can block startup for 76s (STA-5765). */

// GPU failures can prevent ready-to-show; bound the diagnostic deferral.
const REPORT_FALLBACK_MS = 15_000

export function scheduleSecretProtectionGapReport({
  deferUntilFirstWindow,
  skipInDevelopment = false,
  ...options
}: {
  dataFile: string
  force?: boolean
  log?: (message: string) => void
  /** Serve probes inline before readiness so a blocking keyring cannot stall paired clients. */
  deferUntilFirstWindow: boolean
  /** Development profiles are disposable/isolated and must not trigger OS keychain UI. */
  skipInDevelopment?: boolean
}): void {
  if (skipInDevelopment && !options.force) {
    return
  }

  if (!deferUntilFirstWindow) {
    reportSecretProtectionGap(options)
    return
  }

  // Deferred throws become fatal uncaught exceptions instead of promise rejections (#9441).
  const report = (): void => {
    try {
      reportSecretProtectionGap(options)
    } catch (error) {
      try {
        ;(options.log ?? console.warn)(
          `[secrets] could not run the deferred protection report: ${String(error)}`
        )
      } catch {
        // Diagnostics must survive a throwing log sink.
      }
    }
  }

  runAfterFirstWindowShown(report, REPORT_FALLBACK_MS)
}
