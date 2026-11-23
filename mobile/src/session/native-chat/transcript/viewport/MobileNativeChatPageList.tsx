import type { MobileNativeChatItemJump } from './use-mobile-native-chat-item-navigation'
import { useMobileNativeChatPageItemJump } from './use-mobile-native-chat-page-item-jump'
import {
  Fragment,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type Ref
} from 'react'
import type {
  NativeScrollEvent,
  NativeSyntheticEvent,
  StyleProp,
  ViewStyle,
  ScrollViewInstance
} from 'react-native'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { MobileNativeChatRowKeys } from '../projection/mobile-native-chat-row-keys'
import { MobileNativeChatPageScroll } from './MobileNativeChatPageScroll'
import {
  DRAW_AHEAD_SCREENS,
  isMobileNativeChatPageScroller,
  mobileNativeChatRowAbove,
  mobileNativeChatRowBoxProps,
  mobileNativeChatRowOffsets,
  type MobileNativeChatScrollNode
} from './mobile-native-chat-reading-place'
import { useMobileNativeChatPageGrowthHold } from './use-mobile-native-chat-page-growth-hold'
import { MobileNativeChatLandedPromptContext } from './mobile-native-chat-landed-prompt'
import { useMobileNativeChatPromptStep } from './use-mobile-native-chat-prompt-step'
import type { MobileNativeChatListHandle } from './use-mobile-native-chat-tail-follow'
import type { MobileNativeChatScrollRoots } from './mobile-native-chat-scroll-roots'
import { scrollWritesStopMomentum } from './mobile-native-chat-scroll-motion'
import {
  savedMobileNativeChatDrawn,
  useMobileNativeChatPlaceKeeper,
  type MobileNativeChatDrawn
} from './use-mobile-native-chat-place-keeper'
import { MobileNativeChatGrowthHoldContext } from './mobile-native-chat-growth-hold'

const FIRST_ROWS = 24
const DRAW_BATCH = 12
// While following, rows drawn past this many screens above the tail are dropped.
const TRIM_SCREENS = 6
// Fetch ahead far enough for multi-screen phone flicks.
const FETCH_AHEAD_ROWS = 40
const FETCH_REACH_SCREENS = 10

type Row = { item: NativeChatMessage; index: number }
function domElementOf(node: unknown): Element | null {
  return typeof Element !== 'undefined' && node instanceof Element ? node : null
}
type Props = {
  itemJump?: MobileNativeChatItemJump
  roots?: MobileNativeChatScrollRoots
  ref: Ref<MobileNativeChatListHandle>
  isFollowing: () => boolean
  onEndDistance: (fromEnd: number, byReader: boolean) => void
  onPreviousPromptAvailable: (available: boolean) => void
  /** The reader is back where they left `scope`, away from its tail. */
  onPlaceRestored: (scope: string) => void
  rows: readonly NativeChatMessage[]
  rowKeys: Pick<MobileNativeChatRowKeys, 'scope' | 'keyOf' | 'current' | 'placement'>
  renderItem: (row: Row) => ReactElement
  runs?: ReadonlyMap<number, readonly NativeChatMessage[]>
  // Regrouping changes layout, so preserve the reading place through the update.
  layoutKey: string
  contentContainerStyle: StyleProp<ViewStyle>
  header: ReactElement | null
  footer: ReactElement | null
  emptyStateView: ReactElement | null
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
  onNearTop?: () => void
}

// End anchoring preserves position when history prepends; restore after below-reader changes only at rest or on regroup.
export function MobileNativeChatPageList({
  ref,
  itemJump,
  roots,
  isFollowing,
  onEndDistance,
  onPreviousPromptAvailable,
  onPlaceRestored,
  rows: liveRows,
  rowKeys,
  renderItem,
  runs,
  layoutKey,
  contentContainerStyle,
  header,
  footer: liveFooter,
  emptyStateView,
  onScroll,
  onNearTop
}: Props): ReactElement {
  const scroll = useRef<ScrollViewInstance>(null)
  const scroller = useCallback(() => {
    const node: unknown = scroll.current?.getScrollableNode()
    return isMobileNativeChatPageScroller(node) ? node : null
  }, [])

  const readerScrolledAt = useRef(0)
  const { rows, heldFrom, heldAt, held, growth, resting, hold, unhold } =
    useMobileNativeChatPageGrowthHold({
      liveRows,
      liveFooter,
      renderItem,
      runs,
      rowKeys,
      scroller,
      isFollowing,
      readerScrolledAt
    })
  const keys = useMemo(() => rows.map(rowKeys.keyOf), [rows, rowKeys.keyOf])
  const indexOf = useMemo(() => new Map(keys.map((key, at) => [key, at])), [keys])
  const n = keys.length
  const [drawn, setDrawn] = useState<MobileNativeChatDrawn>(
    () =>
      savedMobileNativeChatDrawn(rowKeys.scope) ?? {
        scope: rowKeys.scope,
        firstKey: null,
        count: 0
      }
  )
  const kept = drawn.scope === rowKeys.scope ? drawn : savedMobileNativeChatDrawn(rowKeys.scope)
  const opening = Math.max(0, n - FIRST_ROWS)
  const firstKey = kept?.firstKey ?? null
  const normalFirst =
    firstKey === null
      ? opening
      : (indexOf.get(firstKey) ??
        indexOf.get(rowKeys.current(firstKey) ?? '') ??
        Math.max(0, n - (kept?.count ?? FIRST_ROWS)))

  const first = Math.min(normalFirst, indexOf.get(itemJump?.rowKey ?? '') ?? normalFirst)

  const own = useRef<number | null>(null)
  const ask = useRef(onNearTop)
  // Read latest committed geometry from event handlers between renders.
  const latest = useRef({ first, opening, n, keys, indexOf, layoutKey, rowKeys, rows })
  useLayoutEffect(() => {
    latest.current = { first, opening, n, keys, indexOf, layoutKey, rowKeys, rows }
    ask.current = onNearTop
  })

  const write = useCallback((s: MobileNativeChatScrollNode, to: number) => {
    const top = Math.min(0, Math.max(to, s.clientHeight - s.scrollHeight))
    if (Math.abs(top - s.scrollTop) >= 0.5) {
      s.scrollTop = top
      own.current = s.scrollTop
    }
  }, [])

  const { notePlace, keepPlace, forgetPlace } = useMobileNativeChatPlaceKeeper({
    latest,
    roots,
    isFollowing,
    resting,
    write,
    setDrawn,
    onEndDistance,
    onPlaceRestored
  })

  const keepDrawn = useCallback((at: number) => {
    const {
      rowKeys: { scope },
      keys: committedKeys,
      n: count
    } = latest.current
    setDrawn({ scope, firstKey: committedKeys[at] ?? null, count: count - at })
  }, [])
  const scrollRowToTop = useCallback(
    (key: string): boolean => {
      const s = scroller()
      const by = s && mobileNativeChatRowOffsets(s)(key)
      if (!s || by == null) {
        return false
      }
      // Growth right after the tap must correct to this row, not re-read a displaced one.
      readerScrolledAt.current = 0
      write(s, s.scrollTop + by)
      notePlace(s)
      return true
    },
    [scroller, write, notePlace]
  )
  const { afterCommit, cancel, landed, previous, update } = useMobileNativeChatPromptStep({
    latest,
    scope: rowKeys.scope,
    scroller,
    onAvailable: onPreviousPromptAvailable,
    onEndDistance,
    keepDrawn,
    scrollRowToTop
  })

  const drawAndFetch = useCallback(
    (s: MobileNativeChatScrollNode) => {
      const { first: at, opening, indexOf: rowAt } = latest.current
      const screens = (s.scrollHeight - s.clientHeight + s.scrollTop) / s.clientHeight
      let next = at
      if (at > 0 && screens < DRAW_AHEAD_SCREENS) {
        next = Math.max(0, at - DRAW_BATCH)
      } else if (at < opening && screens > TRIM_SCREENS && isFollowing()) {
        // Cut at a row wholly above the draw-ahead line so drawing never wants it back.
        const cut = mobileNativeChatRowAbove(s, DRAW_AHEAD_SCREENS * s.clientHeight)
        next = Math.min(rowAt.get(cut ?? '') ?? at, opening)
      }
      if (next !== at) {
        keepDrawn(next)
      }
      if (at < FETCH_AHEAD_ROWS && screens < FETCH_REACH_SCREENS) {
        ask.current?.()
      }
    },
    [isFollowing, keepDrawn]
  )

  useImperativeHandle(
    ref,
    () => ({
      scrollToEnd: () => {
        cancel()
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
      scrollRowToTop: (key) => {
        cancel()
        scrollRowToTop(key)
      },
      jumpToPreviousPrompt: previous
    }),
    [cancel, scroller, write, scrollRowToTop, previous]
  )

  useMobileNativeChatPageItemJump({
    itemJump,
    scroller,
    forgetPlace,
    first,
    keepDrawn: (at) =>
      setDrawn({ scope: rowKeys.scope, firstKey: keys[at] ?? null, count: n - at }),
    write
  })

  const drawnHead = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    const s = scroller()
    if (!s) {
      return
    }
    // Chromium keeps a touch scroll's offset from the top, so rows drawn or cut above would carry the reader with them; a write hands the scroll the end-anchored offset.
    if (keys[first] !== drawnHead.current) {
      drawnHead.current = keys[first]
      if (!resting() && !scrollWritesStopMomentum()) {
        const top = s.scrollTop
        s.scrollTop = top - 1
        write(s, top)
      }
    }
    keepPlace(s)
    afterCommit(s)
    drawAndFetch(s)
  })

  // Content and viewport resizes (e.g. the composer growing) bypass commits; restore nested scroll boxes first.
  useEffect(() => {
    const s = scroller()
    const viewport = domElementOf(scroll.current?.getScrollableNode())
    const content = domElementOf(scroll.current?.getInnerViewNode())
    if (!s || !viewport || !content || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      roots?.restoreAll()
      keepPlace(s)
      update(s)
      drawAndFetch(s)
    })
    observer.observe(viewport)
    observer.observe(content)
    roots?.observeWith(observer)
    return () => {
      roots?.observeWith(null)
      observer.disconnect()
    }
  }, [scroller, roots, keepPlace, drawAndFetch, update])

  const scrolled = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      onScroll(event)
      const s = scroller()
      if (!s) {
        return
      }
      const byReader = own.current === null || Math.abs(s.scrollTop - own.current) >= 1
      // RN Web repeats the last scroll event 100 ms after scrolling stops; keep our write so that repeat is ours too.
      if (byReader) {
        cancel()
        own.current = null
        readerScrolledAt.current = Date.now()
      }
      onEndDistance(Math.max(0, -s.scrollTop), byReader)
      if (isFollowing()) {
        unhold()
      } else if (byReader) {
        hold()
      }
      if (byReader) {
        notePlace(s)
      }
      drawAndFetch(s)
      update(s)
    },
    [
      onScroll,
      scroller,
      onEndDistance,
      isFollowing,
      hold,
      unhold,
      notePlace,
      drawAndFetch,
      cancel,
      update
    ]
  )

  return (
    <MobileNativeChatPageScroll
      ref={scroll}
      contentContainerStyle={contentContainerStyle}
      // Let link/file taps land while the composer keyboard is up
      // instead of being swallowed by the dismiss gesture.
      keyboardShouldPersistTaps="handled"
      onScroll={scrolled}
      scrollEventThrottle={16}
    >
      <MobileNativeChatLandedPromptContext.Provider value={landed}>
        <MobileNativeChatGrowthHoldContext.Provider value={growth}>
          {header}
          {rows.length === 0 ? (
            emptyStateView
          ) : (
            // Key by chat to reset rows; persist disclosures above windowed rows. Block flow avoids relaying out every row for each streamed token.
            <div key={rowKeys.scope} {...mobileNativeChatRowBoxProps}>
              {rows.slice(first).map((item, at) => {
                const index = first + at
                return (
                  <Fragment key={keys[index]}>
                    {held && index >= heldFrom
                      ? held.renderItem({ item, index: index - heldAt })
                      : renderItem({ item, index })}
                  </Fragment>
                )
              })}
            </div>
          )}
          {held ? held.footer : liveFooter}
        </MobileNativeChatGrowthHoldContext.Provider>
      </MobileNativeChatLandedPromptContext.Provider>
    </MobileNativeChatPageScroll>
  )
}
