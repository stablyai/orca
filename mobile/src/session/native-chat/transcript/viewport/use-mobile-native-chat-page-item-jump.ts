import { useLayoutEffect } from 'react'
import { spacing } from '../../../../theme/mobile-theme'
import {
  mobileNativeChatRowId,
  type MobileNativeChatScrollNode
} from './mobile-native-chat-reading-place'
import type { MobileNativeChatItemJump } from './use-mobile-native-chat-item-navigation'

export function useMobileNativeChatPageItemJump({
  itemJump,
  scroller,
  forgetPlace,
  first,
  keepDrawn,
  write
}: {
  itemJump?: MobileNativeChatItemJump
  scroller: () => MobileNativeChatScrollNode | null
  forgetPlace: () => void
  first: number
  keepDrawn: (first: number) => void
  write: (node: MobileNativeChatScrollNode, offset: number) => void
}) {
  useLayoutEffect(() => {
    const s = scroller()
    if (!s || !itemJump) {
      return
    }
    const node = Array.from(s.querySelectorAll('[data-testid^="chat-row:"]')).find(
      (node) => node.getAttribute('data-testid') === mobileNativeChatRowId(itemJump.rowKey)
    )
    if (!node) {
      return
    }
    const box = node.getBoundingClientRect()
    const view = s.getBoundingClientRect()
    if (box.bottom <= box.top) {
      return
    }
    forgetPlace()
    if (box.top < view.top + spacing.lg || box.bottom > view.bottom) {
      itemJump.beforeScroll()
      write(s, s.scrollTop + box.top - view.top - spacing.lg)
    }
    keepDrawn(first)
    itemJump.complete()
  }, [first, itemJump, keepDrawn, forgetPlace, scroller, write])
}
