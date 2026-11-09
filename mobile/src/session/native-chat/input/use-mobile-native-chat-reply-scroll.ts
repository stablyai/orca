import { useRef } from 'react'
import type {
  LayoutChangeEvent,
  NativeScrollEvent,
  NativeSyntheticEvent,
  ScrollView,
  TextInput
} from 'react-native'

// Keep a focused reply in view when its card shrinks above the keyboard.
export function useMobileNativeChatReplyScroll() {
  const scrollRef = useRef<ScrollView>(null)
  const inputRef = useRef<TextInput>(null)
  const viewportHeight = useRef(0)
  const scrollOffset = useRef(0)
  const revealReply = (): void => {
    if (inputRef.current?.isFocused()) {
      scrollRef.current?.scrollToEnd({ animated: false })
    }
  }
  // Only shrinking can hide the reply; a step change that grows the card keeps its reset to the question.
  const onViewportLayout = (event: LayoutChangeEvent): void => {
    const { height } = event.nativeEvent.layout
    const shrank = height < viewportHeight.current
    viewportHeight.current = height
    if (shrank) {
      revealReply()
    }
  }
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>): void => {
    scrollOffset.current = event.nativeEvent.contentOffset.y
  }
  // Scroll just enough to show content that opened below the visible edge, never past its top.
  const revealContent = (top: number, bottom: number): void => {
    const hidden = bottom - (scrollOffset.current + viewportHeight.current)
    if (viewportHeight.current > 0 && hidden > 0) {
      scrollRef.current?.scrollTo({
        y: Math.min(scrollOffset.current + hidden, top),
        animated: true
      })
    }
  }
  const scrollViewProps = {
    ref: scrollRef,
    onLayout: onViewportLayout,
    onScroll,
    scrollEventThrottle: 16
  }
  return {
    scrollRef,
    inputRef,
    revealReply,
    onViewportLayout,
    scrollViewProps,
    revealContent
  }
}
