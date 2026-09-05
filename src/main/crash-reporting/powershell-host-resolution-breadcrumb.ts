import {
  setWindowsPowerShellHostResolutionObserver,
  warmWindowsPowerShellHostCache,
  type WindowsPowerShellHostResolution
} from '../../shared/windows-powershell-host'
import { recordDurableCrashBreadcrumb } from './durable-crash-breadcrumb'

// Why bounded: the candidate list grows with PATH, and a breadcrumb carrying
// forty entries evicts the ring it is meant to be read alongside. The
// candidates that were actually spawned are the ones worth keeping.
const MAX_REPORTED_ATTEMPTS = 6

function summarizeAttempts(resolution: WindowsPowerShellHostResolution): string {
  return resolution.attempts
    .filter((attempt) => !attempt.absent)
    .slice(0, MAX_REPORTED_ATTEMPTS)
    .map(
      (attempt) =>
        `${attempt.path} ok=${attempt.ok} exit=${attempt.exitCode ?? 'none'} marker=${attempt.markerOk ?? false} timedOut=${attempt.timedOut ?? false} ms=${attempt.durationMs}`
    )
    .join(' | ')
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
      fellBack: resolution.fellBack,
      probedCount: resolution.attempts.filter((attempt) => !attempt.absent).length,
      candidateCount: resolution.attempts.length,
      attempts: summarizeAttempts(resolution)
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
