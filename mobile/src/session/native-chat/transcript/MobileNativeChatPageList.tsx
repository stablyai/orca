import type { MobileNativeChatPageListProps } from './mobile-native-chat-page-list-props'
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement
} from 'react'
import type { NativeScrollEvent, NativeSyntheticEvent, ScrollViewInstance } from 'react-native'
import { MobileNativeChatPageScroll } from './MobileNativeChatPageScroll'
import {
  mobileNativeChatReadingDrift,
  measureMobileNativeChatPageRows,
  mobileNativeChatUndrawnHeight,
  mobileNativeChatReadingPlace,
  mobileNativeChatRowAbove,
  mobileNativeChatRowBoxProps,
  type MobileNativeChatReadingUnit,
  type MobileNativeChatDrawnWindow,
  type MobileNativeChatScrollNode
} from './mobile-native-chat-reading-place'
import { scrollWritesStopMomentum } from './mobile-native-chat-scroll-motion'
import {
  createMobileNativeChatGrowthHold,
  mobileNativeChatHeldRows,
  type MobileNativeChatHeldRows as Held,
  MobileNativeChatGrowthHoldContext
} from './mobile-native-chat-growth-hold'

const FIRST_ROWS = 24
const DRAW_BATCH = 12
const DRAW_AHEAD_SCREENS = 3
// While following, rows drawn past this many screens above the tail are dropped.
const TRIM_SCREENS = 6
// Fetch ahead far enough for multi-screen phone flicks.
const FETCH_AHEAD_ROWS = 40
const FETCH_REACH_SCREENS = 10
// Wait for scroll and touch rest before corrections so iOS momentum is not interrupted.
const REST_MS = 300

type Listen = (type: string, listener: () => void, options: AddEventListenerOptions) => void
type Scroller = MobileNativeChatScrollNode & {
  addEventListener: Listen
  removeEventListener: Listen
}
// RN 0.88 types these handles as native tags; on web they are the DOM nodes this list observes.
function isScroller(node: unknown): node is Scroller {
  return typeof node === 'object' && node !== null && 'addEventListener' in node
}
function isDomNode(node: unknown): node is Element {
  return typeof node === 'object' && node !== null
}
function domElementOf(node: unknown): Element | null {
  return isDomNode(node) ? node : null
}

// End anchoring preserves position when history prepends; restore after below-reader changes only at rest or on regroup.
export function MobileNativeChatPageList({
  ref,
  roots,
  isFollowing,
  onEndDistance,
  rows: liveRows,
  rowKeys,
  renderItem,
  layoutKey,
  contentContainerStyle,
  header: liveHeader,
  footer: liveFooter,
  emptyStateView,
  onScroll,
  onNearTop
}: MobileNativeChatPageListProps): ReactElement {
  const scroll = useRef<ScrollViewInstance>(null)
  const scroller = useCallback((): Scroller | null => {
    const node: unknown = scroll.current?.getScrollableNode()
    return isScroller(node) ? node : null
  }, [])

  // Hold below-reader growth during a fling: correcting scroll mid-fling stops iOS momentum. Keep the hold in a ref to avoid a render until release.
  const heldRef = useRef<Held | null>(null)
  const [, release] = useState(0)
  const held = heldRef.current
  const { rows, heldFrom, heldAt } = useMemo(
    () => mobileNativeChatHeldRows(held, liveRows, rowKeys),
    [held, liveRows, rowKeys]
  )
  const header = held ? held.header : liveHeader
  const footer = held ? held.footer : liveFooter
  const keys = useMemo(() => rows.map(rowKeys.keyOf), [rows, rowKeys.keyOf])
  const indexOf = useMemo(() => new Map(keys.map((key, at) => [key, at])), [keys])
  const n = keys.length
  const [drawn, setDrawn] = useState<MobileNativeChatDrawnWindow>({
    scope: rowKeys.scope,
    firstKey: null,
    count: 0
  })
  const kept = drawn.scope === rowKeys.scope ? drawn : null
  const opening = Math.max(0, n - FIRST_ROWS)
  const firstKey = kept?.firstKey ?? null
  const first = kept?.automatic
    ? Math.max(0, n - kept.count)
    : kept?.fromStart
      ? 0
      : firstKey === null
        ? opening
        : (indexOf.get(firstKey) ??
          indexOf.get(rowKeys.current(firstKey) ?? '') ??
          Math.max(0, n - (kept?.count ?? FIRST_ROWS)))

  const rowHeights = useMemo(() => new Map<string, number>(), [rowKeys.scope, layoutKey])
  const beforeRowsHeight = mobileNativeChatUndrawnHeight(keys, first, rowHeights)
  const measureDrawn = useCallback(
    (s: Scroller) => measureMobileNativeChatPageRows(s, rowHeights),
    [rowHeights]
  )
  useLayoutEffect(() => {
    const retained = new Set(keys)
    for (const key of rowHeights.keys()) {
      if (!retained.has(key)) {
        rowHeights.delete(key)
      }
    }
  }, [keys, rowHeights])

  const own = useRef<number | null>(null)
  const touching = useRef(false)
  const readerScrolledAt = useRef(0)
  const place = useRef<MobileNativeChatReadingUnit[] | null>(null)
  const placedLayout = useRef(layoutKey)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const live = useRef<Held>({ rows: liveRows, header: liveHeader, footer: liveFooter, renderItem })
  const ask = useRef(onNearTop)
  // Read latest committed geometry from event handlers between renders.
  const latest = useRef({ first, opening, n, keys, indexOf, layoutKey, rowKeys, beforeRowsHeight })
  useLayoutEffect(() => {
    latest.current = { first, opening, n, keys, indexOf, layoutKey, rowKeys, beforeRowsHeight }
    ask.current = onNearTop
    live.current = { rows: liveRows, header: liveHeader, footer: liveFooter, renderItem }
  })

  const write = useCallback((s: Scroller, to: number) => {
    const top = Math.min(0, Math.max(to, s.clientHeight - s.scrollHeight))
    if (Math.abs(top - s.scrollTop) >= 0.5) {
      s.scrollTop = top
      own.current = s.scrollTop
    }
  }, [])

  const resting = useCallback(
    () => !touching.current && Date.now() - readerScrolledAt.current >= REST_MS,
    []
  )

  // Keep one reading anchor so whole-pixel corrections cannot accumulate rounding drift.
  const notePlace = useCallback(
    (s: Scroller) => {
      const { first, n, keys, layoutKey, rowKeys } = latest.current
      const reading = !isFollowing()
      place.current = reading ? mobileNativeChatReadingPlace(s, rowKeys) : null
      placedLayout.current = layoutKey
      if (!reading) {
        setDrawn((current) =>
          current.scope === rowKeys.scope && current.detached
            ? { scope: rowKeys.scope, firstKey: null, count: 0 }
            : current
        )
      } else if (keys[first] !== undefined) {
        // Appends may slide the opening tail window only until the reader takes it.
        setDrawn((current) => {
          if (current.scope !== rowKeys.scope || current.firstKey === null || current.automatic) {
            return {
              scope: rowKeys.scope,
              firstKey: keys[first]!,
              count: n - first,
              fromStart: first === 0,
              detached: true
            }
          }
          return current.fromStart || current.detached ? current : { ...current, detached: true }
        })
      }
    },
    [isFollowing]
  )

  const keepPlace = useCallback(
    (s: Scroller) => {
      const held = place.current
      const regrouped = placedLayout.current !== latest.current.layoutKey
      if (!held || isFollowing() || !(regrouped || resting())) {
        notePlace(s)
        return
      }
      const drift = mobileNativeChatReadingDrift(held, s, latest.current.rowKeys, roots)
      if (Math.abs(drift) >= 0.5) {
        write(s, s.scrollTop + drift)
      }
      // A regroup draws other parts: the line is re-read from them.
      if (regrouped) {
        notePlace(s)
      }
    },
    [isFollowing, notePlace, resting, roots, write]
  )

  const settle = useRef(() => {})
  const [growth] = useState(createMobileNativeChatGrowthHold)
  const unhold = useCallback(() => {
    if (heldRef.current) {
      heldRef.current = null
      growth.set(false)
      release((n) => n + 1)
    }
  }, [])
  const hold = useCallback(() => {
    if (!isFollowing()) {
      heldRef.current ??= live.current
      growth.set(true)
      clearTimeout(settleTimer.current)
      settleTimer.current = setTimeout(() => settle.current(), REST_MS)
    }
  }, [isFollowing])
  useLayoutEffect(() => {
    settle.current = () => {
      if (resting() || isFollowing()) {
        unhold()
      } else {
        settleTimer.current = setTimeout(() => settle.current(), REST_MS)
      }
    }
  })
  // A hidden chat keeps its hold but loses the timer and touch listeners; settle it again when the chat shows.
  useEffect(() => {
    if (heldRef.current) {
      settle.current()
    }
    return () => {
      clearTimeout(settleTimer.current)
      touching.current = false
    }
  }, [])

  const drawAndFetch = useCallback(
    (s: Scroller) => {
      const {
        first: at,
        opening,
        keys: drawnKeys,
        indexOf: rowAt,
        n: total,
        rowKeys: current,
        beforeRowsHeight
      } = latest.current
      const screens =
        (s.scrollHeight - s.clientHeight + s.scrollTop - beforeRowsHeight) / s.clientHeight
      let next = at
      if (at > 0 && screens < DRAW_AHEAD_SCREENS) {
        next = Math.max(0, at - DRAW_BATCH)
      } else if (at < opening && screens > TRIM_SCREENS && isFollowing()) {
        // Cut at a row wholly above the draw-ahead line so drawing never wants it back.
        const cut = mobileNativeChatRowAbove(s, DRAW_AHEAD_SCREENS * s.clientHeight)
        next = Math.min(rowAt.get(cut ?? '') ?? at, opening)
      }
      if (next !== at && (isFollowing() || resting())) {
        const automatic = isFollowing()
        setDrawn((previous) => ({
          scope: current.scope,
          firstKey: drawnKeys[next]!,
          count: total - next,
          fromStart: next === 0,
          detached: !automatic && next > 0 && previous.scope === current.scope && previous.detached,
          automatic
        }))
      }
      if (at < FETCH_AHEAD_ROWS && screens < FETCH_REACH_SCREENS) {
        ask.current?.()
      }
    },
    [isFollowing, resting]
  )

  useImperativeHandle(
    ref,
    () => ({
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
      }
    }),
    [scroller, write]
  )

  const drawnHead = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    const s = scroller()
    if (!s) {
      return
    }
    measureDrawn(s)
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
      measureDrawn(s)
      keepPlace(s)
      drawAndFetch(s)
    })
    observer.observe(viewport)
    observer.observe(content)
    roots?.observeWith(observer)
    return () => {
      roots?.observeWith(null)
      observer.disconnect()
    }
  }, [scroller, roots, measureDrawn, keepPlace, drawAndFetch])

  useEffect(() => {
    const s = scroller()
    if (!s) {
      return
    }
    // A release that hands over to a fling comes right after a scroll, which still counts.
    const down = () => {
      touching.current = true
      hold()
    }
    const up = () => {
      touching.current = false
    }
    const options = { capture: true, passive: true }
    // Listen to both touch and pointer events because either can arrive first or be missing.
    const downs = ['touchstart', 'pointerdown']
    const ups = ['touchend', 'touchcancel', 'pointerup', 'pointercancel']
    downs.forEach((type) => s.addEventListener(type, down, options))
    ups.forEach((type) => s.addEventListener(type, up, options))
    return () => {
      downs.forEach((type) => s.removeEventListener(type, down, options))
      ups.forEach((type) => s.removeEventListener(type, up, options))
    }
  }, [scroller, hold])

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
    },
    [onScroll, scroller, onEndDistance, isFollowing, hold, unhold, notePlace, drawAndFetch]
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
      <MobileNativeChatGrowthHoldContext.Provider value={growth}>
        {header}
        {rows.length === 0 ? (
          emptyStateView
        ) : (
          // Key by chat to reset rows; persist disclosures above windowed rows. Block flow avoids relaying out every row for each streamed token.
          <div key={rowKeys.scope} {...mobileNativeChatRowBoxProps}>
            <div style={{ height: beforeRowsHeight }} />
            {rows.slice(first).map((item, at) => {
              const index = first + at
              return (
                <div key={keys[index]} data-native-chat-page-row={keys[index]}>
                  {held && index >= heldFrom
                    ? held.renderItem({ item, index: index - heldAt })
                    : renderItem({ item, index })}
                </div>
              )
            })}
          </div>
        )}
        {footer}
      </MobileNativeChatGrowthHoldContext.Provider>
    </MobileNativeChatPageScroll>
  )
}
