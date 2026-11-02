import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Platform, StyleSheet, View, type LayoutRectangle } from 'react-native'
import Animated, {
  useAnimatedRef,
  useSharedValue,
  type AnimatedRef,
  type SharedValue
} from 'react-native-reanimated'
import { spacing } from '../theme/mobile-theme'
import { MobileEdgeFade } from '../components/MobileEdgeFade'

/** Desktop's `max-h-40`: three one-line cards and part of a fourth, whose cut-off edge is the
 *  sign that the list scrolls. */
export const QUEUE_LIST_MAX_HEIGHT = 160

export type MobileQueueDragViewport = {
  scrollRef: AnimatedRef<Animated.ScrollView>
  scrollOffsetY: SharedValue<number>
  scrollContentHeight: SharedValue<number>
  onDragActiveChange: (active: boolean) => void
}

type Metrics = { offset: number; viewport: number; content: number }

/** Compact cards are capped; the full editor yields to the available chat viewport. */
export function MobileQueuedMessageScrollList({
  messageIds,
  newestIsPersons,
  inlineEditorActive = false,
  children
}: {
  messageIds: readonly string[]
  /** The newest card has no sender: the person just queued it, so the list shows it. */
  newestIsPersons: boolean
  inlineEditorActive?: boolean
  /** Rows, given `reveal` to keep an edited row in view. */
  children: (reveal: (row: LayoutRectangle) => void, drag: MobileQueueDragViewport) => ReactNode
}): React.JSX.Element {
  const scrollRef = useAnimatedRef<Animated.ScrollView>()
  const scrollOffsetY = useSharedValue(0)
  const scrollContentHeight = useSharedValue(0)
  const [dragging, setDragging] = useState(false)
  const metrics = useRef<Metrics>({ offset: 0, viewport: 0, content: 0 })
  const shownIds = useRef<ReadonlySet<string>>(new Set(messageIds))
  const flashed = useRef(false)
  const [cues, setCues] = useState({ above: false, below: false })
  useLayoutEffect(() => {
    const newest = messageIds.at(-1)
    const appended =
      shownIds.current.size > 0 && newest !== undefined && !shownIds.current.has(newest)
    shownIds.current = new Set(messageIds)
    // Reveal the committed own append even when a simultaneous removal keeps content size equal.
    if (appended && newestIsPersons) {
      scrollRef.current?.scrollToEnd({ animated: false })
    }
  }, [messageIds, newestIsPersons])
  const measure = (next: Partial<Metrics>) => {
    const m = Object.assign(metrics.current, next)
    const above = m.offset > 1
    const below = m.offset + m.viewport < m.content - 1
    setCues((prev) => (prev.above === above && prev.below === below ? prev : { above, below }))
    if (!flashed.current && m.viewport > 0 && m.content > m.viewport + 1) {
      flashed.current = true
      if (Platform.OS === 'ios') {
        scrollRef.current?.flashScrollIndicators()
      }
    }
  }
  // The nearest scroll that shows the whole row, as desktop's editor does, clear of the edge fades.
  const reveal = (row: LayoutRectangle) => {
    const { offset, viewport, content } = metrics.current
    if (viewport === 0) {
      return
    }
    const rowBottom = row.y + row.height
    // Never past the content's end, which may not have caught up with a row that just grew.
    const top = Math.max(0, row.y - spacing.lg)
    const bottom = Math.min(Math.max(content, rowBottom), rowBottom + spacing.lg)
    if (row.height > viewport || top < offset) {
      scrollRef.current?.scrollTo({ y: top, animated: false })
    } else if (bottom > offset + viewport) {
      scrollRef.current?.scrollTo({ y: bottom - viewport, animated: false })
    }
  }
  return (
    <View style={inlineEditorActive && styles.inline}>
      <Animated.ScrollView
        ref={scrollRef}
        style={inlineEditorActive ? styles.inline : styles.scroll}
        scrollEnabled={!dragging}
        nestedScrollEnabled
        showsVerticalScrollIndicator
        persistentScrollbar
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={32}
        onScroll={(event) => {
          scrollOffsetY.value = event.nativeEvent.contentOffset.y
          measure({ offset: event.nativeEvent.contentOffset.y })
        }}
        onLayout={(event) => measure({ viewport: event.nativeEvent.layout.height })}
        onContentSizeChange={(_width, height) => {
          scrollContentHeight.value = height
          measure({ content: height })
        }}
      >
        {children(reveal, {
          scrollRef,
          scrollOffsetY,
          scrollContentHeight,
          onDragActiveChange: setDragging
        })}
      </Animated.ScrollView>
      {cues.above ? <MobileEdgeFade edge="top" /> : null}
      {cues.below ? <MobileEdgeFade edge="bottom" /> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: { maxHeight: QUEUE_LIST_MAX_HEIGHT },
  inline: { flexShrink: 1, minHeight: 0 }
})
