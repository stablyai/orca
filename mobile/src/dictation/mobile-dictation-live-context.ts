import { createContext } from 'react'
import type { MobileDictationMeter } from '../hooks/mobile-dictation-meter'
import type { MobileDictationEngineShown } from '../hooks/mobile-dictation-session-state'

export type MobileDictationLive = {
  readonly meter: MobileDictationMeter
  readonly engine: MobileDictationEngineShown | null
  // The paired computer's name; null when another server runs the workspace and the phone lacks its name.
  readonly computerName: string | null
  // Also discards a failed dictation's kept recording.
  readonly cancel: () => void
  // The short reason a dictation failed with its recording kept; Retry plays it to the computer again.
  readonly failureReason: string | null
  readonly retry: () => void
}

// The chat mic sits several composers deep (overlay, queued edits); it reads the live dictation from here.
export const MobileDictationLiveContext = createContext<MobileDictationLive | null>(null)
