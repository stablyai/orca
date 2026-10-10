import { parseDictationStreamFailure } from '../../../src/shared/dictation-stream-failure'

/** How long a failed stream's finish ignores taps before a tap may give up on its text. */
export const FAILED_STREAM_FINISH_GRACE_MS = 3_000

/** `grace`: a failed stream's finish just started, taps are ignored; `cancellable`: a tap may cancel it. */
export type FailedStreamFinishPhase = 'none' | 'grace' | 'cancellable'

export type MobileDictationStreamSalvage = {
  /** True when the host reported this dictation's stream failed; the first claim runs `finish`
   *  (null while a stop is already finishing). False (after dropping any pending salvage) keeps the cancel path for any other error. */
  claim: (dictationId: string, err: unknown, finish: (() => Promise<void>) | null) => boolean
  /** The provider message to show once the salvaged text is inserted; clears it. */
  take: (dictationId: string) => string | null
  reset: () => void
  /** Stops the grace timer for good (unmount). */
  dispose: () => void
}

export function createMobileDictationStreamSalvage(
  onPhaseChange: (phase: FailedStreamFinishPhase) => void = () => {}
): MobileDictationStreamSalvage {
  let pending: { dictationId: string; message: string } | null = null
  let graceTimer: ReturnType<typeof setTimeout> | null = null
  const stopGraceTimer = () => {
    if (graceTimer !== null) {
      clearTimeout(graceTimer)
      graceTimer = null
    }
  }
  const clear = () => {
    stopGraceTimer()
    if (pending !== null) {
      pending = null
      onPhaseChange('none')
    }
  }
  return {
    claim: (dictationId, err, finish) => {
      const message = parseDictationStreamFailure(err instanceof Error ? err.message : String(err))
      if (message === null) {
        // Why: the caller cancels the dictation next, so a salvage still pending must not keep its phase.
        clear()
        return false
      }
      if (pending?.dictationId !== dictationId) {
        stopGraceTimer()
        pending = { dictationId, message }
        onPhaseChange('grace')
        graceTimer = setTimeout(() => {
          graceTimer = null
          onPhaseChange('cancellable')
        }, FAILED_STREAM_FINISH_GRACE_MS)
        void finish?.()
      }
      return true
    },
    take: (dictationId) => {
      const message = pending?.dictationId === dictationId ? pending.message : null
      clear()
      return message
    },
    reset: clear,
    dispose: stopGraceTimer
  }
}
