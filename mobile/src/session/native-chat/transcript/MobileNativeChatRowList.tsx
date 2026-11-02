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
  applyTrailingStop,
  previousMessageChained,
  previousMessageTarget,
  tailOffsetBeforeFirstScroll
} from './mobile-native-chat-previous-message'
import {
  mobileNativeChatRowAnchor,
  type MobileNativeChatListHandle,
  type MobileNativeChatTailFollow
} from './use-mobile-native-chat-tail-follow'

type NativeJumpBag = {
  layouts: Map<string, number>
  heights: Map<string, number>
  contentOffsetY: number
  viewportHeight: number
  /** A finger drag, or a scroll event with a non-zero offset. A mount event of 0 is still the tail. */
  offsetTrusted: boolean
  /** The stop's offset. Its momentum end is not the reader releasing on the tail. */
  stoppedAt: number | null
  suppressMomentum: boolean
  retry: { key: string; index: number; left: number; animated: boolean } | null
  /** Row this jump is bringing to the top. A second tap steps from it, not the live offset. */
  inflightKey: string | null
  /** Programmatic stop and jump scrolls are not a finger drag. */
  ownScroll: boolean
  refreshFrame: number
  jumpFrame: number
  rows: readonly NativeChatMessage[]
  keyOf: (row: NativeChatMessage) => string
  refresh: () => void
  flatRef: RefObject<FlatList<NativeChatMessage> | null>
}

function withOwnedScroll(jump: NativeJumpBag, run: () => void): void {
  jump.ownScroll = true
  try {
    run()
  } finally {
    jump.ownScroll = false
  }
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
      bag.heights.delete(key)
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
        const height = event.nativeEvent.layout.height
        if (y === 0 && index > 0) {
          bag.layouts.delete(key)
          bag.heights.delete(key)
        } else {
          bag.layouts.set(key, y)
          bag.heights.set(key, height)
          const pending = bag.retry
          if (pending?.key === key) {
            bag.retry = null
            withOwnedScroll(bag, () => {
              bag.flatRef.current?.scrollToOffset({ offset: y, animated: false })
            })
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
      heights: new Map(),
      contentOffsetY: 0,
      viewportHeight: 0,
      offsetTrusted: false,
      stoppedAt: null,
      suppressMomentum: false,
      retry: null,
      inflightKey: null,
      ownScroll: false,
      refreshFrame: 0,
      jumpFrame: 0,
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
    const readingOffset = () => {
      const bottoms: number[] = []
      for (const [key, y] of jump.layouts) {
        bottoms.push(y + (jump.heights.get(key) ?? 0))
      }
      // A fresh list reports offset 0 while it is painted on the tail. Trust 0 only after a real move.
      return tailOffsetBeforeFirstScroll(
        jump.offsetTrusted,
        jump.contentOffsetY,
        jump.viewportHeight,
        bottoms
      )
    }
    const measure = (keys: readonly string[], offset: number) => {
      return keys.map((key) => {
        const y = jump.layouts.get(key)
        return y === undefined ? { key } : { key, top: y - offset }
      })
    }
    const stopAt = (offset: number) => {
      jump.stoppedAt = offset
      jump.suppressMomentum = true
      withOwnedScroll(jump, () => {
        flatRef.current?.scrollToOffset({ offset, animated: false })
      })
      jump.suppressMomentum = false
    }
    const handle: MobileNativeChatListHandle = {
      scrollToEnd: (params) => {
        // A later layout of the old row must not pull the reader back.
        jump.retry = null
        jump.inflightKey = null
        flatRef.current?.scrollToEnd(params)
      },
      scrollToOffset: (params) => {
        jump.retry = null
        jump.inflightKey = null
        flatRef.current?.scrollToOffset(params)
      },
      hasPreviousMessage: (keys) => previousMessageTarget(measure(keys, readingOffset())) !== null,
      revealPreviousMessage: (keys, animated) => {
        const fromKey = jump.inflightKey
        // Stop before measuring. A second scroll in this same turn is dropped on iOS, so the jump waits a frame.
        const place = readingOffset()
        stopAt(place)
        const measured = measure(keys, place)
        const target = fromKey
          ? previousMessageChained(measured, fromKey)
          : previousMessageTarget(measured)
        if (!target) {
          return
        }
        const rowIndex = new Map(jump.rows.map((row, index) => [jump.keyOf(row), index]))
        const chosen = applyTrailingStop(
          target,
          fromKey,
          measured,
          (key) => rowIndex.get(key) ?? -1,
          jump.rows.map((row) => {
            const y = jump.layouts.get(jump.keyOf(row))
            return y === undefined ? undefined : y - place
          })
        )
        const key = 'key' in chosen ? chosen.key : chosen.pendingKey
        const index = rowIndex.get(key) ?? -1
        if (index === -1) {
          return
        }
        const y = jump.layouts.get(key)
        // Commit the next row before the deferred jump, so a second tap chains from it.
        jump.inflightKey = key
        if (jump.jumpFrame !== 0) {
          cancelAnimationFrame(jump.jumpFrame)
        }
        jump.jumpFrame = requestAnimationFrame(() => {
          jump.jumpFrame = 0
          if (jump.inflightKey !== key) {
            return
          }
          withOwnedScroll(jump, () => {
            if (y !== undefined && 'key' in chosen && (y > 0 || index === 0)) {
              jump.retry = null
              flatRef.current?.scrollToOffset({ offset: y, animated })
              return
            }
            jump.retry = { key, index, left: 2, animated }
            flatRef.current?.scrollToIndex({ index, viewPosition: 0, animated })
          })
        })
      }
    }
    attach(handle)
    return () => {
      attach(null)
      jump.retry = null
      jump.inflightKey = null
      if (jump.refreshFrame !== 0) {
        cancelAnimationFrame(jump.refreshFrame)
        jump.refreshFrame = 0
      }
      if (jump.jumpFrame !== 0) {
        cancelAnimationFrame(jump.jumpFrame)
        jump.jumpFrame = 0
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
          const y = event.nativeEvent.contentOffset.y
          jump.contentOffsetY = y
          jump.viewportHeight = event.nativeEvent.layoutMeasurement?.height || jump.viewportHeight
          jump.offsetTrusted ||= y > 0
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
            withOwnedScroll(jump, () => {
              flatRef.current?.scrollToOffset({
                offset: info.averageItemLength * info.index,
                animated: pending.animated
              })
            })
          }
          requestAnimationFrame(() => {
            if (jump.retry !== pending) {
              return
            }
            withOwnedScroll(jump, () => {
              flatRef.current?.scrollToIndex({
                index: info.index,
                viewPosition: 0,
                animated: pending.animated
              })
            })
          })
        }}
        onScrollBeginDrag={() => {
          if (jump.ownScroll) {
            return
          }
          jump.offsetTrusted = true
          jump.retry = null
          jump.inflightKey = null
          tail.beginUserScroll()
        }}
        onScrollEndDrag={tail.endUserDrag}
        onMomentumScrollBegin={tail.beginMomentum}
        onMomentumScrollEnd={(event) => {
          const offset = event.nativeEvent.contentOffset.y
          jump.contentOffsetY = offset
          jump.offsetTrusted ||= offset > 0
          if (jump.suppressMomentum || jump.ownScroll) {
            return
          }
          const landed = jump.inflightKey ? jump.layouts.get(jump.inflightKey) : undefined
          // The stop along the way is short of the committed row. Only a real landing ends the chain.
          if (landed !== undefined && Math.abs(offset - landed) <= PREVIOUS_MESSAGE_ALIGN_PX) {
            jump.inflightKey = null
          } else if (
            jump.inflightKey &&
            jump.stoppedAt !== null &&
            Math.abs(offset - jump.stoppedAt) <= PREVIOUS_MESSAGE_ALIGN_PX
          ) {
            return
          }
          tail.endMomentum(event)
        }}
        scrollEventThrottle={32}
        onContentSizeChange={tail.pinToTailAfterContentResize}
        onLayout={(event) => {
          jump.viewportHeight = event.nativeEvent.layout.height
          tail.pinToTail()
        }}
        maintainVisibleContentPosition={mobileNativeChatRowAnchor(hasHeader)}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        ListEmptyComponent={emptyStateView}
      />
    </NativeJumpContext.Provider>
  )
}
