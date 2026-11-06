import { useCallback, useEffect } from 'react'
import { triggerEdgeBump, triggerSelection } from '../platform/haptics'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'

/** Taps when recording begins and returns a stop that ticks. */
export function useMobileDictationHaptics(dictation: UseMobileDictationResult): () => void {
  // Fire on the commit, not the press: starting waits on the host and may fail.
  useEffect(() => {
    if (dictation.isRecording) {
      triggerEdgeBump()
    }
  }, [dictation.isRecording])

  return useCallback(() => {
    triggerSelection()
    void dictation.stop()
  }, [dictation])
}
