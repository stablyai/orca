import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Platform, StyleSheet, View, useWindowDimensions, type LayoutRectangle } from 'react-native'
import Animated, {
  useAnimatedRef,
  useSharedValue,
  type AnimatedRef,
  type SharedValue
} from 'react-native-reanimated'
import { spacing } from '../../../../theme/mobile-theme'
import { MobileEdgeFade } from '../../../../components/MobileEdgeFade'
import { useMobileNativeChatLowerRegion } from '../../lower-region/mobile-native-chat-lower-region-context'
import { QUEUED_ROW_NARROW_WIDTH } from './mobile-native-chat-queued-message-styles'

/**
 * Three 60pt message rows and part of a fourth, whose cut-off edge is the sign that the list scrolls;
 * room too for three when one carries a two-line failure caption, so three are never cut.
 */
export const QUEUE_LIST_MAX_HEIGHT = 212
/** The same below the narrow width, where each message takes two lines and a row grows to about 73pt. */
export const QUEUE_LIST_NARROW_MAX_HEIGHT = 264

export type MobileQueueDragViewport = {
  scrollRef: AnimatedRef<Animated.ScrollView>
  scrollOffsetY: SharedValue<number>
  scrollContentHeight: SharedValue<number>
  onDragActiveChange: (active: boolean) => void
}

/** A list that has not measured itself by then has moved on (folded, or the row left). */
const SHOW_PENDING_MS = 1000

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
  /** Rows, given `reveal` to keep an edited row in view and `show` to scroll the list to a row. */
  children: (
    reveal: (row: LayoutRectangle) => void,
    drag: MobileQueueDragViewport,
    show: (row: LayoutRectangle) => void
  ) => ReactNode
}): React.JSX.Element {
  const scrollRef = useAnimatedRef<Animated.ScrollView>()
  const narrow = useWindowDimensions().width < QUEUED_ROW_NARROW_WIDTH
  const lowerRegion = useMobileNativeChatLowerRegion()
  const scrollOffsetY = useSharedValue(0)
  const scrollContentHeight = useSharedValue(0)
  const [dragging, setDragging] = useState(false)
  const metrics = useRef<Metrics>({ offset: 0, viewport: 0, content: 0 })
  const shownIds = useRef<ReadonlySet<string>>(new Set(messageIds))
  const flashed = useRef(false)
  const [cues, setCues] = useState({ above: false, below: false })
  // A list that just opened may not have measured itself yet; show the row once it has, if soon.
  const pendingShow = useRef<LayoutRectangle | null>(null)
  const pendingExpiry = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(pendingExpiry.current), [])
  useLayoutEffect(() => {
    const newest = messageIds.at(-1)
    const appended =
      shownIds.current.size > 0 && newest !== undefined && !shownIds.current.has(newest)
    const changed =
      messageIds.length !== shownIds.current.size ||
      messageIds.some((messageId) => !shownIds.current.has(messageId))
    shownIds.current = new Set(messageIds)
    // A row asked for before the queue changed is not where it was.
    if (changed) {
      pendingShow.current = null
    }
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
    const pending = pendingShow.current
    if (pending && m.viewport > 0 && m.content >= pending.y + pending.height) {
      show(pending)
    }
    if (!flashed.current && m.viewport > 0 && m.content > m.viewport + 1) {
      flashed.current = true
      if (Platform.OS === 'ios') {
        scrollRef.current?.flashScrollIndicators()
      }
    }
  }
  // The nearest scroll that shows the whole row, as desktop's editor does, clear of the edge fades.
  const scrollIntoView = (row: LayoutRectangle) => {
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
  const show = (row: LayoutRectangle) => {
    const { viewport, content } = metrics.current
    if (viewport === 0 || content < row.y + row.height) {
      pendingShow.current = row
      clearTimeout(pendingExpiry.current)
      pendingExpiry.current = setTimeout(() => {
        pendingShow.current = null
      }, SHOW_PENDING_MS)
      return
    }
    pendingShow.current = null
    clearTimeout(pendingExpiry.current)
    scrollIntoView(row)
  }
  // An inline editor inside a lower region lets that region scroll instead.
  const reveal = (row: LayoutRectangle) => {
    if (lowerRegion) {
      lowerRegion.layoutChanged()
      return
    }
    scrollIntoView(row)
  }
  return (
    // Always shrinkable: under a height limit the list gives up rows (and scrolls) before the box
    // clips the fold row below it.
    <View style={styles.inline}>
      <Animated.ScrollView
        ref={scrollRef}
        style={inlineEditorActive ? styles.inline : narrow ? styles.scrollNarrow : styles.scroll}
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
        {children(
          reveal,
          {
            scrollRef,
            scrollOffsetY,
            scrollContentHeight,
            onDragActiveChange: setDragging
          },
          show
        )}
      </Animated.ScrollView>
      {cues.above ? <MobileEdgeFade edge="top" /> : null}
      {cues.below ? <MobileEdgeFade edge="bottom" /> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: { maxHeight: QUEUE_LIST_MAX_HEIGHT, flexShrink: 1, minHeight: 0 },
  scrollNarrow: { maxHeight: QUEUE_LIST_NARROW_MAX_HEIGHT, flexShrink: 1, minHeight: 0 },
  inline: { flexShrink: 1, minHeight: 0 }
})
