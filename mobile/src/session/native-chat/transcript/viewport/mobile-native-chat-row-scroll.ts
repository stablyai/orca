import { createContext, useLayoutEffect, useRef, useState } from 'react'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'

/** Scrolls the transcript so this row's start is at the top; absent outside a chat list. */
export const MobileNativeChatRowScrollContext = createContext<
  ((message: NativeChatMessage) => void) | null
>(null)

/** One stable action for every row, so a streamed revision re-renders no row's actions. */
export function useMobileNativeChatRowScroll(
  rows: readonly NativeChatMessage[],
  keyOf: (row: NativeChatMessage) => string,
  scrollRowToTop: (index: number) => void
): (message: NativeChatMessage) => void {
  const latest = useRef({ rows, keyOf, scrollRowToTop })
  useLayoutEffect(() => {
    latest.current = { rows, keyOf, scrollRowToTop }
  })
  const [scroll] = useState(() => (message: NativeChatMessage) => {
    const { rows: shown, keyOf: key, scrollRowToTop: scrollTo } = latest.current
    const target = key(message)
    const index = shown.findIndex((row) => key(row) === target)
    if (index !== -1) {
      scrollTo(index)
    }
  })
  return scroll
}
