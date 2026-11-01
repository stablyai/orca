import { createContext } from 'react'
import type { MobileComposerImagePasteHandler } from './mobile-native-chat-composer-image-paste'

// The chat view is at its line cap, so the overlay hands paste in through context.
export const MobileNativeChatImagePasteContext = createContext<
  MobileComposerImagePasteHandler | undefined
>(undefined)

export const MobileNativeChatImagePasteSkipContext = createContext<
  ((skippedCount: number) => void) | undefined
>(undefined)
