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
  ScrollView,
  StyleProp,
  ViewStyle
} from 'react-native'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { MobileNativeChatRowKeys } from './mobile-native-chat-row-keys'
import { MobileNativeChatPageScroll } from './MobileNativeChatPageScroll'
import {
  mobileNativeChatReadingDrift,
  mobileNativeChatReadingPlace,
  type MobileNativeChatReadingUnit,
  type MobileNativeChatScrollNode
} from './mobile-native-chat-reading-place'
import type { MobileNativeChatListHandle } from './use-mobile-native-chat-tail-follow'
import type { MobileNativeChatScrollRoots } from './mobile-native-chat-scroll-roots'
import {
  createMobileNativeChatGrowthHold,
  MobileNativeChatGrowthHoldContext
} from './mobile-native-chat-growth-hold'

/** Rows a chat opens with; more are drawn as the reader nears the top of what is drawn. */
const FIRST_ROWS = 24
const DRAW_BATCH = 12
/** Rows above are drawn while the top of what is drawn is within this many screens. */
const DRAW_AHEAD_SCREENS = 3
/** An older page is asked for once fewer loaded rows than this are left to draw above, and the
 *  top of what is drawn is within reach: a phone flick crosses several screens. */
const FETCH_AHEAD_ROWS = 40
const FETCH_REACH_SCREENS = 10
/** No scroll of the reader's and no touch for this long: a correction now moves nothing in motion. */
const REST_MS = 300

type Row = { item: NativeChatMessage; index: number }
type Listen = (type: string, listener: () => void, options: AddEventListenerOptions) => void
/** What the list reads of RN Web's scrollable node. */
type Scroller = MobileNativeChatScrollNode & {
  addEventListener: Listen
  removeEventListener: Listen
}
/** What a scrolling reader sees below them, held until they rest. */
type Held = {
  rows: readonly NativeChatMessage[]
  footer: ReactElement | null
  /** Drawn as they were: a row's look comes from the chat's state too (a run's members, its turn). */
  renderItem: (row: Row) => ReactElement
}

type Props = {
  roots?: MobileNativeChatScrollRoots
  ref: Ref<MobileNativeChatListHandle>
  isFollowing: () => boolean
  onEndDistance: (fromEnd: number, byReader: boolean) => void
  rows: readonly NativeChatMessage[]
  rowKeys: Pick<MobileNativeChatRowKeys, 'scope' | 'keyOf' | 'current' | 'placement'>
  renderItem: (row: Row) => ReactElement
  /** Each run's rows by its head's index: the head draws them all. */
  runs?: ReadonlyMap<number, readonly NativeChatMessage[]>
  /** How rows draw (Tools, text size): a change re-lays every row, so the place is kept mid-scroll. */
  layoutKey: string
  contentContainerStyle: StyleProp<ViewStyle>
  header: ReactElement | null
  footer: ReactElement | null
  emptyStateView: ReactElement | null
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
  /** Asks for an older page; absent while none may load. */
  onNearTop?: () => void
}

/** Where the drawn rows start: by key, so rows streaming in below don't move it. */
type Drawn = { scope: string; firstKey: string | null; count: number }

/** The page's transcript, anchored at its end. Rows added above never move the reader, so older
 *  history lands and draws at any time, mid-fling included. What moves a parked reader is a change
 *  below them (a reply streaming in, Tools, text size, an image loading): the line they read goes
 *  back to where it was, once the scroll is at rest or at once for a regroup. */
export function MobileNativeChatPageList({
  ref,
  roots,
  isFollowing,
  onEndDistance,
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
  const scroll = useRef<ScrollView>(null)
  const scroller = useCallback((): Scroller | null => {
    const node: Scroller | null | undefined = scroll.current?.getScrollableNode()
    return node ?? null
  }, [])

  // A change below a scrolling reader would push the line they read, and putting it back mid-fling
  // would stop the fling on iOS, or be lost. So what is below them holds until they rest; older rows
  // still land above, where they move nothing.
  // A ref, so holding costs no render: only letting the held changes in does.
  const heldRef = useRef<Held | null>(null)
  const [, release] = useState(0)
  const held = heldRef.current
  const { rows, heldFrom, heldAt } = useMemo(() => {
    const unheld = { rows: liveRows, heldFrom: Infinity, heldAt: 0 }
    const head = held?.rows[0]
    const at = head ? liveRows.findIndex((row) => rowKeys.keyOf(row) === rowKeys.keyOf(head)) : -1
    if (!held || at === -1) {
      return unheld
    }
    // An older page can begin a run the held rows are in; its head draws them, so they draw live.
    let last: NativeChatMessage | undefined
    for (const [index, members] of runs ?? []) {
      if (index >= at) {
        break
      }
      last = members.at(-1)
    }
    const from = Math.max(at, last ? liveRows.indexOf(last, at) + 1 : 0)
    const kept = liveRows.slice(at, from).every((row, i) => {
      const was = held.rows[i]
      return was !== undefined && rowKeys.keyOf(was) === rowKeys.keyOf(row)
    })
    return kept
      ? {
          rows: [...liveRows.slice(0, from), ...held.rows.slice(from - at)],
          heldFrom: from,
          heldAt: at
        }
      : unheld
  }, [held, liveRows, rowKeys, runs])
  const footer = held ? held.footer : liveFooter
  const keys = useMemo(() => rows.map(rowKeys.keyOf), [rows, rowKeys.keyOf])
  const indexOf = useMemo(() => new Map(keys.map((key, at) => [key, at])), [keys])
  const n = keys.length
  const [drawn, setDrawn] = useState<Drawn>({ scope: rowKeys.scope, firstKey: null, count: 0 })
  const kept = drawn.scope === rowKeys.scope ? drawn : null
  const opening = Math.max(0, n - FIRST_ROWS)
  const firstKey = kept?.firstKey ?? null
  const first =
    firstKey === null
      ? opening
      : (indexOf.get(firstKey) ??
        indexOf.get(rowKeys.current(firstKey) ?? '') ??
        Math.max(0, n - (kept?.count ?? FIRST_ROWS)))

  const own = useRef<number | null>(null)
  const touching = useRef(false)
  const readerScrolledAt = useRef(0)
  const place = useRef<MobileNativeChatReadingUnit[] | null>(null)
  const placedLayout = useRef(layoutKey)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const live = useRef<Held>({ rows: liveRows, footer: liveFooter, renderItem })
  const ask = useRef(onNearTop)
  // Read at event time, so a scroll or resize between commits acts on the latest render.
  const latest = useRef({ first, n, keys, layoutKey, rowKeys })
  useLayoutEffect(() => {
    latest.current = { first, n, keys, layoutKey, rowKeys }
    ask.current = onNearTop
    live.current = { rows: liveRows, footer: liveFooter, renderItem }
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

  // The line being read where the reader left it: every later correction is measured against it, so
  // whole-pixel scroll writes can't add up to a drift.
  const notePlace = useCallback(
    (s: Scroller) => {
      place.current = isFollowing() ? null : mobileNativeChatReadingPlace(s, latest.current.rowKeys)
      placedLayout.current = latest.current.layoutKey
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

  // The reader moves while parked: hold what is below them, and let it in once they rest.
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
  useEffect(() => () => clearTimeout(settleTimer.current), [])

  const drawAndFetch = useCallback((s: Scroller) => {
    const { first: at, keys: drawnKeys, n: total, rowKeys: current } = latest.current
    const screens = (s.scrollHeight - s.clientHeight + s.scrollTop) / s.clientHeight
    if (at > 0 && screens < DRAW_AHEAD_SCREENS) {
      const next = Math.max(0, at - DRAW_BATCH)
      setDrawn({ scope: current.scope, firstKey: drawnKeys[next]!, count: total - next })
    }
    if (at < FETCH_AHEAD_ROWS && screens < FETCH_REACH_SCREENS) {
      ask.current?.()
    }
  }, [])

  useImperativeHandle(
    ref,
    () => ({
      scrollToEnd: () => {
        const s = scroller()
        if (s) {
          write(s, 0)
        }
      },
      // From the top, as a native list counts it.
      scrollToOffset: ({ offset }) => {
        const s = scroller()
        if (s) {
          write(s, offset - (s.scrollHeight - s.clientHeight))
        }
      }
    }),
    [scroller, write]
  )

  // Every commit: put the line back, then draw or ask for what the reader nears.
  useLayoutEffect(() => {
    const s = scroller()
    if (s) {
      keepPlace(s)
      drawAndFetch(s)
    }
  })

  // Changes no commit makes (an image loading, an inner box settling): the same rule, inner boxes first.
  useEffect(() => {
    const s = scroller()
    const content: Element | null | undefined = scroll.current?.getInnerViewNode()
    if (!s || !content || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      roots?.restoreAll()
      keepPlace(s)
      drawAndFetch(s)
    })
    observer.observe(content)
    roots?.observeWith(observer)
    return () => {
      roots?.observeWith(null)
      observer.disconnect()
    }
  }, [scroller, roots, keepPlace, drawAndFetch])

  // A hand on the list is the reader's: nothing is put back under it.
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
    // Touch and pointer both: a finger fires either first, and one can go missing.
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
      own.current = null
      if (byReader) {
        readerScrolledAt.current = Date.now()
      }
      onEndDistance(Math.max(0, -s.scrollTop), byReader)
      if (isFollowing()) {
        // At the end the newest text shows at once.
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
          // Keyed by the chat, so no row carries into another. Rows above the drawn ones aren't in the
          // document; what the reader opened in them is kept in the chat's disclosure store. Block flow:
          // in a column flexbox each token of a reply re-lays every drawn row.
          <div key={rowKeys.scope}>
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
        {footer}
      </MobileNativeChatGrowthHoldContext.Provider>
    </MobileNativeChatPageScroll>
  )
}
