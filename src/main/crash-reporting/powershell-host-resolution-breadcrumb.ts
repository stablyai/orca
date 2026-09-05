import { win32 } from 'node:path'
import {
  setWindowsPowerShellHostResolutionObserver,
  warmWindowsPowerShellHostCache,
  type WindowsPowerShellHostResolution
} from '../../shared/windows-powershell-host'
import { recordDurableCrashBreadcrumb } from './durable-crash-breadcrumb'

// Keep separate bounded fields so path redaction and string truncation preserve each result.
const MAX_REPORTED_ATTEMPTS = 6

function summarizeAttempts(resolution: WindowsPowerShellHostResolution): Record<string, string> {
  return Object.fromEntries(
    resolution.attempts
      .slice(0, MAX_REPORTED_ATTEMPTS)
      .map((attempt, index) => [
        `attempt${index}`,
        `#${resolution.candidates.indexOf(attempt.path)} ${win32.basename(attempt.path)} absent=${attempt.absent ?? false} ok=${attempt.ok} exit=${attempt.exitCode ?? 'none'} marker=${attempt.markerOk ?? false} timedOut=${attempt.timedOut ?? false} ms=${attempt.durationMs}`
      ])
  )
}

/**
 * Records which PowerShell host Orca picked, and what every probed candidate
 * did. Without it a failed login only shows that some PowerShell ran — not
 * whether the chosen host answered the probe or the fallback was taken because
 * every candidate timed out, which are opposite problems with the same symptom.
 */
export function registerPowerShellHostResolutionBreadcrumb(): void {
  if (process.platform !== 'win32') {
    return
  }
  setWindowsPowerShellHostResolutionObserver((resolution) => {
    recordDurableCrashBreadcrumb('powershell_host_selected', {
      host: resolution.host,
      hostName: win32.basename(resolution.host),
      selectedIndex: resolution.candidates.indexOf(resolution.host),
      fellBack: resolution.fellBack,
      probedCount: resolution.attempts.filter((attempt) => !attempt.absent).length,
      candidateCount: resolution.candidates.length,
      skippedCount: resolution.attempts.filter((attempt) => attempt.absent).length,
      untriedCount: resolution.candidates.length - resolution.attempts.length,
      ...summarizeAttempts(resolution)
    })
  })
}

/**
 * Resolves the host in the background at startup so the first sign-in does not
 * pay for it. Failures are the resolution's own business — it always yields a
 * host — so nothing here needs to handle them.
 */
export function warmPowerShellHostInBackground(): void {
  if (process.platform !== 'win32') {
    return
  }
  void warmWindowsPowerShellHostCache()
}
