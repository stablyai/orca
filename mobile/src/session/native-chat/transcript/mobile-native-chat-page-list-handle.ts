import {
  mobileNativeChatDrawnRow,
  type MobileNativeChatScrollNode
} from './mobile-native-chat-reading-place'
import { watchMobileNativeChatRow } from './mobile-native-chat-row-watch'
import type { MobileNativeChatListHandle } from './use-mobile-native-chat-tail-follow'

export function mobileNativeChatPageListHandle<T extends MobileNativeChatScrollNode>(
  scroller: () => T | null,
  write: (scroller: T, to: number) => void,
  notePlace: (scroller: T) => void,
  drawRow: (key: string) => void
): MobileNativeChatListHandle {
  return {
    scrollToEnd: () => {
      const s = scroller()
      if (s) {
        write(s, 0)
      }
    },
    scrollToOffset: ({ offset }) => {
      const s = scroller()
      if (s) {
        write(s, offset - (s.scrollHeight - s.clientHeight))
      }
    },
    scrollToRow: (key) => {
      const s = scroller()
      const row = s && mobileNativeChatDrawnRow(s, key)
      if (!s || !row) {
        drawRow(key)
        return false
      }
      write(s, s.scrollTop + row.getBoundingClientRect().top - s.getBoundingClientRect().top)
      notePlace(s)
      return true
    },
    watchRow: (key, onShown) => watchMobileNativeChatRow(scroller(), key, onShown)
  }
}
