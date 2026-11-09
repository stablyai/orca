import { createContext, type RefObject } from 'react'
import type { View } from 'react-native'
import type { MobileDictationMeter } from '../hooks/mobile-dictation-meter'
import type { MobileDictationEngineShown } from '../hooks/mobile-dictation-session-state'

export type MobileDictationLive = {
  readonly meter: MobileDictationMeter
  readonly engine: MobileDictationEngineShown | null
  // The paired computer's name; null when another server runs the workspace and the phone lacks its name.
  readonly computerName: string | null
  readonly cancel: () => void
  // The ✕ a held mic may be released over.
  readonly cancelRef: RefObject<View | null>
}

// The chat mic sits several composers deep (overlay, queued edits); it reads the live dictation from here.
export const MobileDictationLiveContext = createContext<MobileDictationLive | null>(null)
