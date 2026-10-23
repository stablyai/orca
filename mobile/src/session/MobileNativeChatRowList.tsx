import type { ComponentProps, ReactElement } from 'react'
import { FlatList, Platform } from 'react-native'
import type { MobileNativeChatRowKeys } from './mobile-native-chat-row-keys'
import { MobileNativeChatPageList } from './MobileNativeChatPageList'
import {
  mobileNativeChatRowAnchor,
  type MobileNativeChatTailFollow
} from './use-mobile-native-chat-tail-follow'

type PageProps = ComponentProps<typeof MobileNativeChatPageList>

type Props = Pick<
  PageProps,
  | 'rows'
  | 'roots'
  | 'renderItem'
  | 'rowState'
  | 'layoutKey'
  | 'contentContainerStyle'
  | 'header'
  | 'footer'
  | 'emptyStateView'
  | 'onScroll'
> & {
  tail: MobileNativeChatTailFollow
  rowKeys: MobileNativeChatRowKeys
  /** The native list's header; with one, the row below it anchors the visible content. */
  nativeHeader: ReactElement | null
  hasHeader: boolean
}

/** The chat's rows: the page draws its own keyed window, a native list recycles through FlatList. */
export function MobileNativeChatRowList(props: Props): ReactElement {
  const { tail, rowKeys, rows, renderItem, contentContainerStyle, onScroll, footer } = props
  if (Platform.OS === 'web') {
    const { roots, rowState, header, emptyStateView, layoutKey } = props
    return (
      <MobileNativeChatPageList
        {...tail.pageListProps}
        {...{ rows, rowKeys, roots, renderItem, rowState, contentContainerStyle }}
        {...{ footer, emptyStateView, onScroll, header, layoutKey }}
      />
    )
  }
  return (
    <FlatList
      {...tail.listProps}
      data={rows}
      keyExtractor={rowKeys.keyOf}
      renderItem={renderItem}
      contentContainerStyle={contentContainerStyle}
      // Let link/file taps land while the composer keyboard is up
      // instead of being swallowed by the dismiss gesture.
      keyboardShouldPersistTaps="handled"
      onScroll={onScroll}
      onScrollBeginDrag={tail.beginUserScroll}
      onScrollEndDrag={tail.endUserDrag}
      onMomentumScrollBegin={tail.beginMomentum}
      onMomentumScrollEnd={tail.endMomentum}
      scrollEventThrottle={32}
      onContentSizeChange={tail.pinToTailAfterContentResize}
      onLayout={tail.pinToTail}
      maintainVisibleContentPosition={mobileNativeChatRowAnchor(props.hasHeader)}
      ListHeaderComponent={props.nativeHeader}
      ListFooterComponent={footer}
      ListEmptyComponent={props.emptyStateView}
    />
  )
}
