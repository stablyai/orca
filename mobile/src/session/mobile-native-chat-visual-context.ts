import { createContext, type ReactNode } from 'react'
import type { NativeChatVisualDirective } from '../../../src/shared/native-chat/native-chat-visual-directive'

export type MobileNativeChatVisualRender = (
  directive: NativeChatVisualDirective,
  index: number
) => ReactNode

// Keep rows independent of the WebView frame; null means visuals cannot render here.
export const MobileNativeChatVisualContext = createContext<MobileNativeChatVisualRender | null>(
  null
)
