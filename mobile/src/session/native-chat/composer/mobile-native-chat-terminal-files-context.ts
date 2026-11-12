import { createContext, useContext } from 'react'
import type { MobileNativeChatTerminalFileAttachments } from './mobile-native-chat-structured-composer'

/** A terminal-backed chat's stored files, provided by its overlay; null in a structured chat, which carries its own. */
export const MobileNativeChatTerminalFilesContext =
  createContext<MobileNativeChatTerminalFileAttachments | null>(null)

export function useMobileNativeChatTerminalFiles(): MobileNativeChatTerminalFileAttachments | null {
  return useContext(MobileNativeChatTerminalFilesContext)
}
