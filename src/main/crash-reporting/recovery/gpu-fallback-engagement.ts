import type { GpuFallbackRestartDecision } from './gpu-fallback-restart-prompt'

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

/** Persist before prompting: Chromium may abort before the user answers. */
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
    // Preserve the marker so a failed prompt cannot restart the hardware crash loop.
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
