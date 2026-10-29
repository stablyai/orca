import { createContext } from 'react'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import type { RpcClient } from '../../../transport/rpc-client'

export type MobileNativeChatViewedImage = { uri: string; label: string }

// Keep overlays above replaceable rows so echo/transcript swaps cannot close a selected image or actions sheet.
export type MobileNativeChatRowOverlays = {
  openImage: (image: MobileNativeChatViewedImage) => void
  openActions: (message: NativeChatMessage) => void
  /** A structured chat's host client, which reads images from its attachment store. */
  imageClient?: RpcClient
}

export const MobileNativeChatRowOverlaysContext = createContext<MobileNativeChatRowOverlays>({
  openImage: () => {},
  openActions: () => {}
})
