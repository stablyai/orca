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
        `#${resolution.candidates.indexOf(attempt.path)} ${win32.basename(attempt.path)} absent=${attempt.absent ?? false} unwrappable=${attempt.unwrappable ?? false} ok=${attempt.ok} exit=${attempt.exitCode ?? 'none'} marker=${attempt.markerOk ?? false} timedOut=${attempt.timedOut ?? false} ms=${attempt.durationMs}`
      ])
  )
}

/** Explain whether login used a verified host or the historical fallback. */
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
      probedCount: resolution.attempts.filter((attempt) => !attempt.absent && !attempt.unwrappable)
        .length,
      candidateCount: resolution.candidates.length,
      skippedCount: resolution.attempts.filter((attempt) => attempt.absent).length,
      unwrappableCount: resolution.attempts.filter((attempt) => attempt.unwrappable).length,
      untriedCount: resolution.candidates.length - resolution.attempts.length,
      ...summarizeAttempts(resolution)
    })
  })
}

/** Start discovery before the first sign-in needs its result. */
export function warmPowerShellHostInBackground(): void {
  if (process.platform !== 'win32') {
    return
  }
  void warmWindowsPowerShellHostCache()
}
