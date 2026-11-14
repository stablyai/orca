import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode
} from 'react'
import {
  View,
  type FlatList,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle
} from 'react-native'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import type { MobileNativeChatListHandle } from './use-mobile-native-chat-tail-follow'

type Box = { y: number; height: number }
type Measure = { keyOf: (row: NativeChatMessage) => string; boxes: Map<string, Box> }
type CellProps = {
  item: NativeChatMessage
  onLayout?: (event: LayoutChangeEvent) => void
  style?: StyleProp<ViewStyle>
  children?: ReactNode
}
type Jump = { index: number; viewOffset: number; tries: number }

const MAX_JUMP_TRIES = 4
const MeasureContext = createContext<Measure | null>(null)

// Only drawn cells are measured: a cell scrolled out of the list drops its stale box.
function MeasuredCell({ item, onLayout, style, children }: CellProps): ReactElement {
  const measure = useContext(MeasureContext)
  const key = measure?.keyOf(item)
  useEffect(
    () => () => {
      if (key !== undefined) {
        measure?.boxes.delete(key)
      }
    },
    [key, measure]
  )
  return (
    <View
      style={style}
      onLayout={(event) => {
        if (key !== undefined) {
          measure?.boxes.set(key, event.nativeEvent.layout)
        }
        onLayout?.(event)
      }}
    >
      {children}
    </View>
  )
}

/** The native list's handle: the FlatList plus the reader's place, read from measured cells. */
export function useMobileNativeChatNativeList(
  rows: readonly NativeChatMessage[],
  keyOf: (row: NativeChatMessage) => string,
  attach: (handle: MobileNativeChatListHandle | null) => void
) {
  const list = useRef<FlatList<NativeChatMessage> | null>(null)
  const offsetY = useRef(0)
  const jump = useRef<Jump | null>(null)
  const latest = useRef({ rows, keyOf })
  useLayoutEffect(() => {
    latest.current = { rows, keyOf }
  })
  const [measure] = useState<Measure>(() => ({
    keyOf: (row) => latest.current.keyOf(row),
    boxes: new Map()
  }))
  const scrollToRow = useCallback((next: Jump) => {
    jump.current = next
    list.current?.scrollToIndex({
      animated: false,
      index: next.index,
      viewPosition: 0,
      viewOffset: next.viewOffset
    })
  }, [])
  const [handle] = useState<MobileNativeChatListHandle>(() => ({
    scrollToEnd: (params) => list.current?.scrollToEnd(params),
    scrollToOffset: (params) => list.current?.scrollToOffset(params),
    readPlace: () => {
      const y = offsetY.current
      for (const row of latest.current.rows) {
        const key = latest.current.keyOf(row)
        const box = measure.boxes.get(key)
        if (box && box.y + box.height > y) {
          return { key, offset: y - box.y }
        }
      }
      return undefined
    },
    restorePlace: ({ key, offset }) => {
      const { rows: shown, keyOf: keyFor } = latest.current
      if (!list.current || shown.length === 0) {
        return 'pending'
      }
      const index = shown.findIndex((row) => keyFor(row) === key)
      if (index === -1) {
        return 'missing'
      }
      scrollToRow({ index, viewOffset: -offset, tries: 0 })
      return 'restored'
    }
  }))
  const ref = useCallback(
    (instance: FlatList<NativeChatMessage> | null) => {
      list.current = instance
      attach(instance ? handle : null)
    },
    [attach, handle]
  )
  // A row past the measured cells: land near it, then aim again once those cells are drawn.
  const onScrollToIndexFailed = useCallback(
    ({ index, averageItemLength }: { index: number; averageItemLength: number }) => {
      list.current?.scrollToOffset({ animated: false, offset: index * averageItemLength })
      const failed = jump.current
      if (failed && failed.index === index && failed.tries < MAX_JUMP_TRIES) {
        requestAnimationFrame(() => scrollToRow({ ...failed, tries: failed.tries + 1 }))
      }
    },
    [scrollToRow]
  )
  const noteScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    offsetY.current = event.nativeEvent.contentOffset.y
  }, [])
  return { ref, measure, onScrollToIndexFailed, noteScroll }
}

export function MobileNativeChatMeasuredRows({
  measure,
  children
}: {
  measure: Measure
  children: ReactNode
}): ReactElement {
  return <MeasureContext value={measure}>{children}</MeasureContext>
}

export { MeasuredCell as MobileNativeChatMeasuredCell }
