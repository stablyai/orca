import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Platform, ScrollView, StyleSheet, View, type LayoutRectangle } from 'react-native'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { colors, spacing } from '../theme/mobile-theme'

/** Desktop's `max-h-40`: three one-line cards and part of a fourth, whose cut-off edge is the
 *  sign that the list scrolls. */
export const QUEUE_LIST_MAX_HEIGHT = 160

type Metrics = { offset: number; viewport: number; content: number }

/** The queued cards under the fixed header, capped so a long queue never takes over the screen. */
export function MobileQueuedMessageScrollList({
  messageIds,
  newestIsPersons,
  children
}: {
  messageIds: readonly string[]
  /** The newest card has no sender: the person just queued it, so the list shows it. */
  newestIsPersons: boolean
  /** Rows, given `reveal` to keep an edited row in view. */
  children: (reveal: (row: LayoutRectangle) => void) => ReactNode
}): React.JSX.Element {
  const scrollRef = useRef<ScrollView>(null)
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
  // The nearest scroll that shows the whole row, as desktop's editor does.
  const reveal = (row: LayoutRectangle) => {
    const { offset, viewport } = metrics.current
    if (viewport === 0) {
      return
    }
    if (row.y < offset) {
      scrollRef.current?.scrollTo({ y: row.y, animated: false })
    } else if (row.y + row.height > offset + viewport) {
      scrollRef.current?.scrollTo({ y: row.y + row.height - viewport, animated: false })
    }
  }
  return (
    <View>
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        nestedScrollEnabled
        showsVerticalScrollIndicator
        persistentScrollbar
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={32}
        onScroll={(event) => measure({ offset: event.nativeEvent.contentOffset.y })}
        onLayout={(event) => measure({ viewport: event.nativeEvent.layout.height })}
        onContentSizeChange={(_width, height) => measure({ content: height })}
      >
        {children(reveal)}
      </ScrollView>
      {cues.above ? <ListEdgeFade edge="top" /> : null}
      {cues.below ? <ListEdgeFade edge="bottom" /> : null}
    </View>
  )
}

/** Fades the cards into the box's fill at an edge more content lies past. */
function ListEdgeFade({ edge }: { edge: 'top' | 'bottom' }): React.JSX.Element {
  const id = `queued-list-fade-${edge}`
  const top = edge === 'top'
  return (
    <View pointerEvents="none" style={[styles.fade, top ? styles.fadeTop : styles.fadeBottom]}>
      <Svg width="100%" height="100%">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={colors.bgPanel} stopOpacity={top ? 1 : 0} />
            <Stop offset="1" stopColor={colors.bgPanel} stopOpacity={top ? 0 : 1} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: { maxHeight: QUEUE_LIST_MAX_HEIGHT },
  fade: { position: 'absolute', left: 0, right: 0, height: spacing.lg },
  fadeTop: { top: 0 },
  fadeBottom: { bottom: 0 }
})
