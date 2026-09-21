import type { GpuFallbackRestartDecision } from './gpu-fallback-restart-prompt'

/** The GPU-crash burst that tripped the software-rendering fallback. */
export type GpuFallbackEngagement = {
  reason: string
  exitCode: number | null
  crashesInWindow: number
  /** Wall-clock ms stamped into the persisted marker. */
  engagedAt: number
}

export type GpuFallbackEngagementHandlers = {
  isQuitting: () => boolean
  /** Writes the build-scoped safe-graphics marker; false when it could not be persisted. */
  persistMarker: (engagement: GpuFallbackEngagement) => boolean
  /** Marks that the user explicitly accepted safe graphics before relaunching. */
  confirmMarker: (engagement: GpuFallbackEngagement) => void
  clearMarker: () => void
  promptForRestart: () => Promise<GpuFallbackRestartDecision>
  onPromptFailed: (error: unknown) => void
  onEngaged: (engagement: GpuFallbackEngagement) => void
  onRestartDeferred: (engagement: GpuFallbackEngagement) => void
  restartIntoSafeGraphics: (engagement: GpuFallbackEngagement) => void
}

/**
 * Drives the safe-graphics handover once a GPU crash burst trips the threshold.
 *
 * Why the marker is written before the prompt: measured on Windows 11 26200 /
 * Electron 43.1.0, Chromium's own GPU ladder aborts the whole browser process
 * (`FATAL gpu_data_manager_impl_private.cc: GPU process isn't usable. Goodbye.`)
 * on the 6th GPU crash — 1.285s after the 3rd, which is the crash that trips
 * this threshold. Persisting only after the user answers a modal means the app
 * dies first, no marker survives, and the next launch retries hardware
 * acceleration: the crash loop never ends. An explicit "Keep Running" undoes it.
 */
export async function engageGpuFallbackAfterCrashBurst(
  engagement: GpuFallbackEngagement,
  handlers: GpuFallbackEngagementHandlers
): Promise<void> {
  handlers.onEngaged(engagement)
  const persisted = handlers.persistMarker(engagement)
  let decision: GpuFallbackRestartDecision
  try {
    decision = await handlers.promptForRestart()
  } catch (error) {
    // Marker stays: the next launch is safe even though the user was never asked.
    handlers.onPromptFailed(error)
    return
  }
  if (handlers.isQuitting()) {
    return
  }
  if (decision !== 'restart') {
    if (persisted) {
      handlers.clearMarker()
    }
    handlers.onRestartDeferred(engagement)
    return
  }
  if (!persisted) {
    return
  }
  handlers.confirmMarker(engagement)
  handlers.restartIntoSafeGraphics(engagement)
}
