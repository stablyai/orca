import {
  createContext,
  useContext,
  useEffect,
  type ReactElement,
  type ReactNode,
  type RefObject
} from 'react'
import {
  FlatList,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewProps,
  type ViewStyle
} from 'react-native'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat/native-chat-types'

export type NativeJumpBag = {
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

export function withOwnedScroll(jump: NativeJumpBag, run: () => void): void {
  jump.ownScroll = true
  try {
    run()
  } finally {
    jump.ownScroll = false
  }
}

export const NativeJumpContext = createContext<NativeJumpBag | null>(null)

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

export function PreviousMessageCell({
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
