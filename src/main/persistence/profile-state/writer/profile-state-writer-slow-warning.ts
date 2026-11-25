import {
  recordProfileStateWriterSlow,
  type ProfileStateWriterDiagnosticRequest,
  type ProfileStateWriterSlowPhase
} from './profile-state-writer-diagnostics'

export const PROFILE_STATE_WRITER_SLOW_WARNING_MS = 30_000

export type ProfileStateWriterSlowWarningOptions = {
  warningMs: number
  phase: ProfileStateWriterSlowPhase
  request: ProfileStateWriterDiagnosticRequest
  /** Monotonic clock; replace in tests to model stalled main loops. */
  now?: () => number
  onSlow?: () => void
}

/** Time alone cannot prove failure; warn once without settling. */
export function startProfileStateWriterSlowWarning({
  warningMs,
  phase,
  request,
  now = () => performance.now(),
  onSlow
}: ProfileStateWriterSlowWarningOptions): () => void {
  const startedAt = now()
  const timer = setTimeout(() => {
    onSlow?.()
    try {
      recordProfileStateWriterSlow({
        ...request,
        phase,
        elapsedMs: Math.max(0, Math.round(now() - startedAt))
      })
    } catch (error) {
      console.error('[persistence] Could not record slow profile state writer:', error)
    }
  }, warningMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}
