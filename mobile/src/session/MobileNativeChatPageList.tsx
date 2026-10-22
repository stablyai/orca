import {
  Fragment,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ReactElement,
  type Ref
} from 'react'
import {
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ScrollView,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { MobileNativeChatRowKeys } from './mobile-native-chat-row-keys'
import { MobileNativeChatPageScroll, outOfAnchoring } from './MobileNativeChatPageScroll'
import type { MobileNativeChatListHandle } from './use-mobile-native-chat-tail-follow'
import type { MobileNativeChatTurnRow } from './use-mobile-native-chat-turn-disclosure'
import type { MobileNativeChatWindowScroller } from './mobile-native-chat-page-window-state'
import { useMobileNativeChatPageWindow } from './use-mobile-native-chat-page-window'
import type { MobileNativeChatScrollRoots } from './mobile-native-chat-scroll-roots'

type Row = { item: NativeChatMessage; index: number }

type Props = {
  roots?: MobileNativeChatScrollRoots
  ref: Ref<MobileNativeChatListHandle>
  endAnchored: boolean
  isFollowing: () => boolean
  pin: () => void
  rows: readonly NativeChatMessage[]
  rowKeys: Pick<MobileNativeChatRowKeys, 'scope' | 'sourceHead' | 'keyOf' | 'current'>
  renderItem: (row: Row) => ReactElement
  /** What a row draws besides itself; a height measured for other state no longer holds. */
  rowState: (index: number, row: NativeChatMessage) => MobileNativeChatTurnRow
  layoutKey: string
  contentContainerStyle: StyleProp<ViewStyle>
  /** `measuring`: rows above are not measured yet, so the Load earlier slot shows loading. */
  header: (measuring: boolean) => ReactElement | null
  footer: ReactElement | null
  emptyStateView: ReactElement | null
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void
}

/** The page's transcript in one keyed flow: RN Web's list draws by index after paint, so opens climbed
 *  and older pages went in its header, where iOS stopped scrolling at the seam. */
export function MobileNativeChatPageList({
  ref,
  roots,
  endAnchored,
  isFollowing,
  pin,
  rows,
  rowKeys,
  renderItem,
  rowState,
  layoutKey,
  contentContainerStyle,
  header,
  footer,
  emptyStateView,
  onScroll
}: Props): ReactElement {
  const scroll = useRef<ScrollView>(null)
  const scroller = useCallback(
    (): MobileNativeChatWindowScroller | null | undefined => scroll.current?.getScrollableNode(),
    []
  )
  const { view, rowRef, list } = useMobileNativeChatPageWindow({
    roots,
    rows,
    rowKeys,
    rowState,
    following: endAnchored,
    isFollowing,
    layoutKey,
    scroller
  })
  useImperativeHandle(
    ref,
    () => ({
      getScrollableNode: () => scroll.current?.getScrollableNode(),
      scrollToOffset: ({ offset, animated }) => {
        list.wrote(offset)
        scroll.current?.scrollTo({ y: offset, animated })
      },
      scrollToEnd: (params) => scroll.current?.scrollToEnd(params),
      ...list
    }),
    [list]
  )
  // After the handle attaches, so a chat's first paint is at its end; later growth the observer pins.
  const opened = useRef('')
  const shown = `${rowKeys.scope}:${rows.length > 0}`
  useLayoutEffect(() => {
    if (opened.current !== shown) {
      opened.current = shown
      pin()
    }
  }, [shown, pin])

  const drawRow = (item: NativeChatMessage, index: number) => {
    const key = rowKeys.keyOf(item)
    return (
      <View key={key} ref={rowRef(key)}>
        {renderItem({ item, index })}
      </View>
    )
  }
  return (
    <MobileNativeChatPageScroll
      ref={scroll}
      contentContainerStyle={contentContainerStyle}
      // Let link/file taps land while the composer keyboard is up
      // instead of being swallowed by the dismiss gesture.
      keyboardShouldPersistTaps="handled"
      onScroll={onScroll}
      scrollEventThrottle={32}
    >
      {/* Never what the browser's anchoring holds: rows land below it, and spacers stand in for rows. */}
      <View style={outOfAnchoring}>{header(view.measuring)}</View>
      {rows.length === 0 ? (
        emptyStateView
      ) : (
        // Keyed by the chat, so no row carries into another. Rows unmount once scrolled past; what
        // the reader opened in them is kept in the chat's disclosure store, above the list.
        <Fragment key={rowKeys.scope}>
          <View style={[outOfAnchoring, { height: view.above }]} />
          {rows.slice(view.m0, view.m1).map((item, at) => drawRow(item, view.m0 + at))}
          <View style={[outOfAnchoring, { height: view.mid }]} />
          {rows.slice(view.start, view.end).map((item, at) => drawRow(item, view.start + at))}
          <View style={[outOfAnchoring, { height: view.bottom }]} />
        </Fragment>
      )}
      {footer}
    </MobileNativeChatPageScroll>
  )
}
