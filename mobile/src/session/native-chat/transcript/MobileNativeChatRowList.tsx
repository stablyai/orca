import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
  type RefObject
} from 'react'
import {
  FlatList,
  Platform,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewProps,
  type ViewStyle
} from 'react-native'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'
import type { MobileNativeChatRowKeys } from './mobile-native-chat-row-keys'
import { MobileNativeChatPageList } from './MobileNativeChatPageList'
import {
  PREVIOUS_MESSAGE_ALIGN_PX,
  previousMessageTarget,
  trailingStopAboveViewport
} from './mobile-native-chat-previous-message'
import {
  mobileNativeChatRowAnchor,
  type MobileNativeChatListHandle,
  type MobileNativeChatTailFollow
} from './use-mobile-native-chat-tail-follow'

type NativeJumpBag = {
  layouts: Map<string, number>
  contentOffsetY: number
  retry: { key: string; index: number; left: number; animated: boolean } | null
  refreshFrame: number
  rows: readonly NativeChatMessage[]
  keyOf: (row: NativeChatMessage) => string
  refresh: () => void
  flatRef: RefObject<FlatList<NativeChatMessage> | null>
}

const NativeJumpContext = createContext<NativeJumpBag | null>(null)

type NativeFocusEvent = Parameters<NonNullable<ViewProps['onFocus']>>[0]

type PreviousMessageCellProps = {
  cellKey: string
  children: ReactNode
  index: number
  item: NativeChatMessage
  onFocusCapture?: (event: NativeFocusEvent) => void
  onLayout?: (event: LayoutChangeEvent) => void
  style?: StyleProp<ViewStyle>
}

function PreviousMessageCell({
  item,
  index,
  style,
  onLayout,
  onFocusCapture,
  children
}: PreviousMessageCellProps): ReactElement {
  const bag = useContext(NativeJumpContext)
  const key = bag?.keyOf(item)
  // A cell outside the render window is unmounted. Its old y would scroll to the wrong place after earlier rows change.
  useEffect(() => {
    if (!bag || key === undefined) {
      return
    }
    return () => {
      bag.layouts.delete(key)
    }
  }, [bag, key])
  // SAFETY: VirtualizedList hands the cell onFocusCapture so a focused row stays rendered. View's public props omit it.
  const focusProps = { onFocusCapture } as ViewProps
  return (
    <View
      style={style}
      {...focusProps}
      onLayout={(event) => {
        onLayout?.(event)
        if (!bag) {
          return
        }
        const key = bag.keyOf(item)
        const y = event.nativeEvent.layout.y
        // A later cell reporting y=0 is an unplaced frame. Storing it looks like the top of the list.
        if (y === 0 && index > 0) {
          bag.layouts.delete(key)
        } else {
          bag.layouts.set(key, y)
          const pending = bag.retry
          if (pending?.key === key) {
            bag.retry = null
            bag.flatRef.current?.scrollToOffset({ offset: y, animated: false })
          }
        }
        if (bag.refreshFrame === 0) {
          bag.refreshFrame = requestAnimationFrame(() => {
            bag.refreshFrame = 0
            bag.refresh()
          })
        }
      }}
    >
      {children}
    </View>
  )
}

type PageProps = ComponentProps<typeof MobileNativeChatPageList>

type Props = Pick<
  PageProps,
  | 'rows'
  | 'roots'
  | 'renderItem'
  | 'runs'
  | 'layoutKey'
  | 'contentContainerStyle'
  | 'header'
  | 'footer'
  | 'emptyStateView'
  | 'onScroll'
  | 'onNearTop'
> & {
  tail: MobileNativeChatTailFollow
  rowKeys: MobileNativeChatRowKeys
  /** With a header, the row below it anchors the native list's visible content. */
  hasHeader: boolean
}

export function MobileNativeChatRowList(props: Props): ReactElement {
  const { tail, rowKeys, rows, renderItem, contentContainerStyle, onScroll, footer } = props
  const { header, emptyStateView } = props
  if (Platform.OS === 'web') {
    const { roots, runs, layoutKey, onNearTop } = props
    return (
      <MobileNativeChatPageList
        {...tail.pageListProps}
        {...{ rows, rowKeys, roots, renderItem, runs, contentContainerStyle, layoutKey }}
        {...{ header, footer, emptyStateView, onScroll, onNearTop }}
      />
    )
  }
  return <MobileNativeChatNativeRowList {...props} />
}

function MobileNativeChatNativeRowList({
  tail,
  rowKeys,
  rows,
  renderItem,
  contentContainerStyle,
  onScroll,
  footer,
  header,
  emptyStateView,
  hasHeader
}: Props): ReactElement {
  const flatRef = useRef<FlatList<NativeChatMessage>>(null)
  const bag = useRef<NativeJumpBag | null>(null)
  if (bag.current === null) {
    bag.current = {
      layouts: new Map(),
      contentOffsetY: 0,
      retry: null,
      refreshFrame: 0,
      rows,
      keyOf: rowKeys.keyOf,
      refresh: tail.refreshPreviousMessage,
      flatRef
    }
  }
  const jump = bag.current
  jump.rows = rows
  jump.keyOf = rowKeys.keyOf
  jump.refresh = tail.refreshPreviousMessage
  const attach = tail.listProps.ref

  useLayoutEffect(() => {
    const measure = (keys: readonly string[]) =>
      keys.map((key) => {
        const y = jump.layouts.get(key)
        return y === undefined ? { key } : { key, top: y - jump.contentOffsetY }
      })
    const handle: MobileNativeChatListHandle = {
      scrollToEnd: (params) => {
        flatRef.current?.scrollToEnd(params)
      },
      scrollToOffset: (params) => {
        flatRef.current?.scrollToOffset(params)
      },
      hasPreviousMessage: (keys) => previousMessageTarget(measure(keys)) !== null,
      revealPreviousMessage: (keys, animated) => {
        const measured = measure(keys)
        const target = previousMessageTarget(measured)
        if (!target) {
          return
        }
        const rowIndex = new Map(jump.rows.map((row, index) => [jump.keyOf(row), index]))
        let visibleAt: number | null = null
        for (const [index, row] of jump.rows.entries()) {
          const y = jump.layouts.get(jump.keyOf(row))
          if (y !== undefined && y - jump.contentOffsetY >= -PREVIOUS_MESSAGE_ALIGN_PX) {
            visibleAt = index
            break
          }
        }
        const trailing =
          visibleAt !== null && 'key' in target
            ? trailingStopAboveViewport(
                measured,
                target.key,
                (key) => rowIndex.get(key) ?? -1,
                visibleAt
              )
            : null
        const chosen = trailing === null ? target : { pendingKey: trailing }
        const key = 'key' in chosen ? chosen.key : chosen.pendingKey
        const index = rowIndex.get(key) ?? -1
        if (index === -1) {
          return
        }
        const y = jump.layouts.get(key)
        if (y !== undefined && 'key' in chosen && (y > 0 || index === 0)) {
          jump.retry = null
          flatRef.current?.scrollToOffset({ offset: y, animated })
          return
        }
        jump.retry = { key, index, left: 2, animated }
        flatRef.current?.scrollToIndex({ index, viewPosition: 0, animated })
      }
    }
    attach(handle)
    return () => {
      attach(null)
      if (jump.refreshFrame !== 0) {
        cancelAnimationFrame(jump.refreshFrame)
        jump.refreshFrame = 0
      }
    }
  }, [attach, jump])

  return (
    <NativeJumpContext.Provider value={jump}>
      <FlatList
        ref={flatRef}
        // SAFETY: CellRendererProps is not exported to app code, and its focus event is not the DOM FocusEvent. The cell forwards style, layout, and focus.
        CellRendererComponent={PreviousMessageCell as never}
        data={rows}
        keyExtractor={rowKeys.keyOf}
        renderItem={renderItem}
        contentContainerStyle={contentContainerStyle}
        // Let link/file taps land while the composer keyboard is up
        // instead of being swallowed by the dismiss gesture.
        keyboardShouldPersistTaps="handled"
        onScroll={(event) => {
          jump.contentOffsetY = event.nativeEvent.contentOffset.y
          onScroll(event)
        }}
        onScrollToIndexFailed={(info) => {
          const pending = jump.retry
          if (!pending || pending.left <= 0) {
            return
          }
          pending.left -= 1
          // averageItemLength 0 would scroll to the top and drop the pending row.
          if (info.averageItemLength > 0) {
            flatRef.current?.scrollToOffset({
              offset: info.averageItemLength * info.index,
              animated: pending.animated
            })
          }
          requestAnimationFrame(() => {
            flatRef.current?.scrollToIndex({
              index: info.index,
              viewPosition: 0,
              animated: pending.animated
            })
          })
        }}
        onScrollBeginDrag={tail.beginUserScroll}
        onScrollEndDrag={tail.endUserDrag}
        onMomentumScrollBegin={tail.beginMomentum}
        onMomentumScrollEnd={tail.endMomentum}
        scrollEventThrottle={32}
        onContentSizeChange={tail.pinToTailAfterContentResize}
        onLayout={tail.pinToTail}
        maintainVisibleContentPosition={mobileNativeChatRowAnchor(hasHeader)}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        ListEmptyComponent={emptyStateView}
      />
    </NativeJumpContext.Provider>
  )
}
