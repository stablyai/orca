import type { ComponentProps, ReactElement } from 'react'
import { FlatList, Platform } from 'react-native'
import type { LegacyComposedGesture } from 'react-native-gesture-handler'
import { MobileNativeChatPinchZoom } from './viewport/mobile-native-chat-pinch-zoom'
import type { MobileNativeChatRowKeys } from './projection/mobile-native-chat-row-keys'
import { MobileNativeChatPageList } from './viewport/MobileNativeChatPageList'
import {
  mobileNativeChatRowAnchor,
  type MobileNativeChatTailFollow
} from './viewport/use-mobile-native-chat-tail-follow'
import {
  MobileNativeChatMeasuredCell,
  MobileNativeChatMeasuredRows,
  useMobileNativeChatNativeList
} from './viewport/use-mobile-native-chat-native-list'

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
  pinchGesture: LegacyComposedGesture
}

export function MobileNativeChatRowList(props: Props): ReactElement {
  const { tail, rowKeys, rows, renderItem, contentContainerStyle, onScroll, footer } = props
  const { header, emptyStateView } = props
  if (Platform.OS === 'web') {
    const { roots, runs, layoutKey, onNearTop } = props
    return (
      <MobileNativeChatPinchZoom gesture={props.pinchGesture}>
        <MobileNativeChatPageList
          {...tail.pageListProps}
          {...{ rows, rowKeys, roots, renderItem, runs, contentContainerStyle, layoutKey }}
          {...{ header, footer, emptyStateView, onScroll, onNearTop }}
        />
      </MobileNativeChatPinchZoom>
    )
  }
  return <NativeRowList {...props} />
}

function NativeRowList(props: Props): ReactElement {
  const { tail, rowKeys, rows, renderItem, contentContainerStyle, onScroll, footer } = props
  const { header, emptyStateView } = props
  const native = useMobileNativeChatNativeList(rows, rowKeys.keyOf, tail.listProps.ref)
  return (
    <MobileNativeChatPinchZoom gesture={props.pinchGesture}>
      <MobileNativeChatMeasuredRows measure={native.measure}>
        <FlatList
          ref={native.ref}
          data={rows}
          keyExtractor={rowKeys.keyOf}
          renderItem={renderItem}
          contentContainerStyle={contentContainerStyle}
          // Let link/file taps land while the composer keyboard is up
          // instead of being swallowed by the dismiss gesture.
          keyboardShouldPersistTaps="handled"
          onScroll={(event) => {
            native.noteScroll(event)
            onScroll(event)
          }}
          CellRendererComponent={MobileNativeChatMeasuredCell}
          onScrollToIndexFailed={native.onScrollToIndexFailed}
          onScrollBeginDrag={tail.beginUserScroll}
          onScrollEndDrag={tail.endUserDrag}
          onMomentumScrollBegin={tail.beginMomentum}
          onMomentumScrollEnd={tail.endMomentum}
          scrollEventThrottle={32}
          onContentSizeChange={tail.pinToTailAfterContentResize}
          onLayout={tail.pinToTail}
          maintainVisibleContentPosition={mobileNativeChatRowAnchor(props.hasHeader)}
          ListHeaderComponent={header ?? undefined}
          ListFooterComponent={footer ?? undefined}
          ListEmptyComponent={emptyStateView ?? undefined}
        />
      </MobileNativeChatMeasuredRows>
    </MobileNativeChatPinchZoom>
  )
}
