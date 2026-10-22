import { createContext } from 'react'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'

export type MobileNativeChatViewedImage = { uri: string; label: string }

/** What a row opens over the chat. Held above the rows, so an open picture or actions sheet stays
 *  open while the row under it is replaced: a sent message's echo by its transcript row, or the
 *  streaming reply by the row it became. */
export type MobileNativeChatRowOverlays = {
  openImage: (image: MobileNativeChatViewedImage) => void
  openActions: (message: NativeChatMessage) => void
}

export const MobileNativeChatRowOverlaysContext = createContext<MobileNativeChatRowOverlays>({
  openImage: () => {},
  openActions: () => {}
})
