import { createContext, type ReactNode } from 'react'
import type { NativeChatVisualDirective } from '../../../src/shared/native-chat-visual-directive'

export type MobileNativeChatVisualRender = (
  directive: NativeChatVisualDirective,
  index: number
) => ReactNode

/**
 * How this transcript renders `::orca-visual` lines, or null where it cannot (no structured chat or
 * no client). Rows read only this, so they never import the WebView frame themselves.
 */
export const MobileNativeChatVisualContext = createContext<MobileNativeChatVisualRender | null>(
  null
)
