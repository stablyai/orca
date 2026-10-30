import { useCallback, useState } from 'react'
import type { UseMobileDictationResult } from '../hooks/use-mobile-dictation'

export type MobileDictationLeaveHold = {
  holdsLeave: boolean
  // True when this leave must wait: it stops a recording so its text is inserted, and the next leave goes.
  hold: () => boolean
}

// Leaving unmounts the screen and with it what was said, so recording or transcribing holds the first leave.
export function useMobileDictationLeaveHold(
  dictation: UseMobileDictationResult
): MobileDictationLeaveHold {
  const { isRecording, isProcessing, stop } = dictation
  const active = isRecording || isProcessing
  // Hold once per dictation, then release Back, so a slow transcript can never trap the user on the screen.
  const [held, setHeld] = useState(false)
  if (held && !active) {
    setHeld(false)
  }
  const holdsLeave = active && !held
  const hold = useCallback(() => {
    if (!holdsLeave) {
      return false
    }
    setHeld(true)
    if (isRecording) {
      void stop()
    }
    return true
  }, [holdsLeave, isRecording, stop])

  return { holdsLeave, hold }
}
