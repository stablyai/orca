import { useCallback, type ReactNode } from 'react'
import { ScrollView, View, type ScrollViewInstance } from 'react-native'
import { useMobileNativeChatTailFollow } from '../session/native-chat/transcript/viewport/use-mobile-native-chat-tail-follow'
import { MobileNativeChatFloatingControls } from '../session/native-chat/lower-region/MobileNativeChatFloatingControls'
import { groupStyles as styles } from './mobile-bot-group-styles'
export function MobileBotGroupTranscript({
  groupId,
  hasItems,
  children
}: {
  groupId: string
  hasItems: boolean
  children: ReactNode
}) {
  const tail = useMobileNativeChatTailFollow({ scopeKey: groupId, hasItems })
  const attach = tail.listProps.ref
  const ref = useCallback(
    (scroll: ScrollViewInstance | null) =>
      attach(
        scroll
          ? {
              scrollToEnd: (options) => scroll.scrollToEnd(options),
              scrollToOffset: ({ offset, animated }) => scroll.scrollTo({ y: offset, animated })
            }
          : null
      ),
    [attach]
  )
  return (
    <View style={styles.grow}>
      <ScrollView
        ref={ref}
        keyboardShouldPersistTaps="handled"
        style={styles.grow}
        contentContainerStyle={styles.transcript}
        onContentSizeChange={tail.pinToTailAfterContentResize}
        onLayout={tail.pinToTail}
        onScroll={(event) => tail.recordScrollMetrics(event.nativeEvent)}
        onScrollBeginDrag={tail.beginUserScroll}
        onScrollEndDrag={tail.endUserDrag}
        onMomentumScrollBegin={tail.beginMomentum}
        onMomentumScrollEnd={tail.endMomentum}
        scrollEventThrottle={32}
      >
        {children}
      </ScrollView>
      <MobileNativeChatFloatingControls
        showJumpToTail={tail.showJumpToTail}
        onJumpToTail={tail.jumpToTail}
      />
    </View>
  )
}
