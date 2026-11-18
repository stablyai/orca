import { createContext } from 'react'

/** Puts a transcript row's start at the top of the chat, provided by its view; undefined outside a chat list. */
export const MobileNativeChatScrollRowToTopContext = createContext<
  ((rowKey: string) => void) | undefined
>(undefined)
