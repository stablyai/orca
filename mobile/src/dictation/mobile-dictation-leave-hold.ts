import { useCallback, useState } from 'react'
import type { UseMobileDictationResult } from '../hooks/mobile-dictation-session-state'

export type MobileDictationLeaveHold = {
  holdsLeave: boolean
  // True when this leave must wait: it stops a recording so its text is inserted, and the next leave goes.
  hold: () => boolean
}

// The dictation outlives its screen inside the page, but leaving the page's document ends it; that leave stops and inserts first.
export function useMobileDictationLeaveHold(
  dictation: UseMobileDictationResult,
  // True when leaving stays inside the page, where the floating pill carries the dictation on.
  leaveKeepsPage: () => boolean
): MobileDictationLeaveHold {
  const { isStarting, isRecording, isProcessing, stop } = dictation
  const active = isStarting || isRecording || isProcessing
  // Hold once per dictation, then release Back, so a slow transcript can never trap the user on the screen.
  const [held, setHeld] = useState(false)
  if (held && !active) {
    setHeld(false)
  }
  const holdsLeave = active && !held
  const hold = useCallback(() => {
    if (!holdsLeave || leaveKeepsPage()) {
      return false
    }
    setHeld(true)
    if (isStarting || isRecording) {
      void stop()
    }
    return true
  }, [holdsLeave, isStarting, isRecording, leaveKeepsPage, stop])

  return { holdsLeave, hold }
}
