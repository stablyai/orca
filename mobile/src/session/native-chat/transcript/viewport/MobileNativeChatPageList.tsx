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
  mobileNativeChatRowAbove,
  mobileNativeChatRowBoxProps,
  mobileNativeChatRowOffset,
  type MobileNativeChatScrollNode
} from './mobile-native-chat-reading-place'
import type { MobileNativeChatListHandle } from './use-mobile-native-chat-tail-follow'
import type { MobileNativeChatScrollRoots } from './mobile-native-chat-scroll-roots'
import { useMobileNativeChatPageMotion } from './use-mobile-native-chat-page-motion'
import {
  savedMobileNativeChatDrawn,
  useMobileNativeChatPlaceKeeper,
  type MobileNativeChatDrawn
} from './use-mobile-native-chat-place-keeper'
import {
  createMobileNativeChatGrowthHold,
  MobileNativeChatGrowthHoldContext
} from './mobile-native-chat-growth-hold'

const FIRST_ROWS = 24
const DRAW_BATCH = 12
// While following, rows drawn past this many screens above the tail are dropped.
const TRIM_SCREENS = 6
// Fetch ahead far enough for multi-screen phone flicks.
const FETCH_AHEAD_ROWS = 40
const FETCH_REACH_SCREENS = 10
// Wait for scroll and touch rest before corrections so iOS momentum is not interrupted.
const REST_MS = 300

type Row = { item: NativeChatMessage; index: number }
type Listen = (type: string, listener: () => void, options: AddEventListenerOptions) => void
type Scroller = MobileNativeChatScrollNode & {
  addEventListener: Listen
  removeEventListener: Listen
}
// RN 0.88 types these handles as native tags; on web they are the DOM nodes this list observes.
function isScroller(node: unknown): node is Scroller {
  return typeof node === 'object' && node !== null && 'addEventListener' in node
}
type Held = {
  rows: readonly NativeChatMessage[]
  footer: ReactElement | null
  // Freeze renderItem too: grouping/turn context changes a row even if its message is unchanged.
  renderItem: (row: Row) => ReactElement
}

type Props = {
  itemJump?: MobileNativeChatItemJump
  roots?: MobileNativeChatScrollRoots
  ref: Ref<MobileNativeChatListHandle>
  isFollowing: () => boolean
  onEndDistance: (fromEnd: number, byReader: boolean) => void
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
  const scroller = useCallback((): Scroller | null => {
    const node: unknown = scroll.current?.getScrollableNode()
    return isScroller(node) ? node : null
  }, [])

  // Hold below-reader growth during a fling: correcting scroll mid-fling stops iOS momentum. Keep the hold in a ref to avoid a render until release.
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
    // A newly prepended run head owns its held members; draw those members live.
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
  const touching = useRef(false)
  const readerScrolledAt = useRef(0)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const live = useRef<Held>({ rows: liveRows, footer: liveFooter, renderItem })
  const ask = useRef(onNearTop)
  // Read latest committed geometry from event handlers between renders.
  const latest = useRef({ first, opening, n, keys, indexOf, layoutKey, rowKeys })
  useLayoutEffect(() => {
    latest.current = { first, opening, n, keys, indexOf, layoutKey, rowKeys }
    ask.current = onNearTop
    live.current = { rows: liveRows, footer: liveFooter, renderItem }
  })

  const write = useCallback((s: MobileNativeChatScrollNode, to: number) => {
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
      const { first: at, opening, keys: drawnKeys, indexOf: rowAt, n: total } = latest.current
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
        const { scope } = latest.current.rowKeys
        setDrawn({ scope, firstKey: drawnKeys[next]!, count: total - next })
      }
      if (at < FETCH_AHEAD_ROWS && screens < FETCH_REACH_SCREENS) {
        ask.current?.()
      }
    },
    [isFollowing]
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

  const { align, scrolled } = useMobileNativeChatPageMotion({
    scroller,
    write,
    notePlace,
    keepPlace,
    latest,
    setDrawn,
    keys,
    first,
    resting,
    drawAndFetch,
    roots,
    scroll,
    hold,
    unhold,
    onScroll,
    onEndDistance,
    isFollowing,
    own,
    readerScrolledAt,
    touching
  })

  useImperativeHandle(
    ref,
    () => ({
      scrollToEnd: () => {
        align.cancelAlign()
        const s = scroller()
        if (s) {
          write(s, 0)
        }
      },
      scrollToOffset: ({ offset }) => {
        align.cancelAlign()
        const s = scroller()
        if (s) {
          write(s, offset - (s.scrollHeight - s.clientHeight))
        }
      },
      hasPreviousMessage: align.hasPreviousMessage,
      revealPreviousMessage: align.revealPreviousMessage,
      scrollRowToTop: (key) => {
        const s = scroller()
        const by = s ? mobileNativeChatRowOffset(s, key) : undefined
        if (s && by !== undefined) {
          // The tap ended any scroll; growth right after must correct to this row, not re-read a displaced one.
          readerScrolledAt.current = 0
          write(s, s.scrollTop + by)
          notePlace(s)
        }
      }
    }),
    [
      align.cancelAlign,
      align.hasPreviousMessage,
      align.revealPreviousMessage,
      scroller,
      write,
      notePlace
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
    </MobileNativeChatPageScroll>
  )
}
