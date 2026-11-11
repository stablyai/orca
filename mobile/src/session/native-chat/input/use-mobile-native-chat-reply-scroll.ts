import { useRef } from 'react'
import type { LayoutChangeEvent, ScrollView, TextInput } from 'react-native'

// Keep a focused reply in view when its card shrinks above the keyboard.
export function useMobileNativeChatReplyScroll() {
  const scrollRef = useRef<ScrollView>(null)
  const inputRef = useRef<TextInput>(null)
  const viewportHeight = useRef(0)
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
  return { scrollRef, inputRef, revealReply, onViewportLayout }
}
