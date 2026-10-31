import type { ComponentProps, ReactElement } from 'react'
import { FlatList, Platform } from 'react-native'
import type { MobileNativeChatRowKeys } from './mobile-native-chat-row-keys'
import { MobileNativeChatPageList } from '../../MobileNativeChatPageList'
import {
  mobileNativeChatRowAnchor,
  type MobileNativeChatTailFollow
} from '../../use-mobile-native-chat-tail-follow'

type PageProps = ComponentProps<typeof MobileNativeChatPageList>

type Props = Pick<
  PageProps,
  | 'rows'
  | 'roots'
  | 'renderItem'
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
}

export function MobileNativeChatRowList(props: Props): ReactElement {
  const { tail, rowKeys, rows, renderItem, contentContainerStyle, onScroll, footer } = props
  const { header, emptyStateView } = props
  if (Platform.OS === 'web') {
    const { roots, layoutKey, onNearTop } = props
    return (
      <MobileNativeChatPageList
        {...tail.pageListProps}
        {...{ rows, rowKeys, roots, renderItem, contentContainerStyle, layoutKey }}
        {...{ header, footer, emptyStateView, onScroll, onNearTop }}
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
      maintainVisibleContentPosition={mobileNativeChatRowAnchor()}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      ListEmptyComponent={emptyStateView}
    />
  )
}
