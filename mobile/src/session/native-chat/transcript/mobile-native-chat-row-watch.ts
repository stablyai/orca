import {
  mobileNativeChatDrawnRow,
  mobileNativeChatRowBox,
  type MobileNativeChatScrollNode
} from './mobile-native-chat-reading-place'

export function watchMobileNativeChatRow(
  scroller: MobileNativeChatScrollNode | null,
  key: string,
  onShown: (shown: boolean) => void
): () => void {
  if (
    !scroller ||
    typeof IntersectionObserver === 'undefined' ||
    typeof MutationObserver === 'undefined' ||
    typeof Element === 'undefined' ||
    !(scroller instanceof Element)
  ) {
    if (scroller && !mobileNativeChatDrawnRow(scroller, key)) {
      onShown(false)
    }
    return () => {}
  }
  let visibility: IntersectionObserver | null = null
  let drawing: MutationObserver | null = null
  const observeRow = (): boolean => {
    const row = mobileNativeChatDrawnRow(scroller, key)
    if (!(row instanceof Element)) {
      return false
    }
    visibility = new IntersectionObserver(([entry]) => onShown(entry?.isIntersecting === true), {
      root: scroller
    })
    visibility.observe(row)
    return true
  }
  let frame: number | null = null
  if (!observeRow()) {
    // The list draws older rows in its own commits after this watch starts; wait for them before calling the row hidden.
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        frame = null
        if (!visibility) {
          onShown(false)
        }
      })
    })
    const box = mobileNativeChatRowBox(scroller)
    if (box instanceof Element) {
      drawing = new MutationObserver(() => {
        if (observeRow()) {
          drawing?.disconnect()
          drawing = null
        }
      })
      drawing.observe(box, { childList: true })
    }
  }
  return () => {
    if (frame !== null) {
      cancelAnimationFrame(frame)
    }
    visibility?.disconnect()
    drawing?.disconnect()
  }
}
