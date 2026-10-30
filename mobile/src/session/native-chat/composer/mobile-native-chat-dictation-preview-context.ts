import { createContext } from 'react'
import type { MobileNativeChatDictationPreview } from './mobile-native-chat-draft-inputs'

// Every chat composer on the session screen reads it; only the one whose scope it names draws it.
export const MobileNativeChatDictationPreviewContext =
  createContext<MobileNativeChatDictationPreview | null>(null)
