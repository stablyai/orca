import { createContext, useContext } from 'react'
import {
  MobileDictationCaptionStrip,
  type MobileDictationCaptionState
} from './MobileDictationCaptionStrip'

// Why: a context reaches the native chat composer without threading props through the chat view,
// and only this consumer re-renders as captions stream in, not the whole composer.
export const MobileDictationCaptionContext = createContext<MobileDictationCaptionState | null>(null)

export function MobileNativeChatDictationCaption() {
  const dictation = useContext(MobileDictationCaptionContext)
  return dictation ? <MobileDictationCaptionStrip dictation={dictation} variant="card" /> : null
}
