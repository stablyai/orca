import { useCallback, type ReactNode } from 'react'
import { ScrollView, View, type ScrollViewInstance } from 'react-native'
import { useMobileNativeChatTailFollow } from '../session/native-chat/transcript/viewport/use-mobile-native-chat-tail-follow'
import { MobileNativeChatFloatingControls } from '../session/native-chat/lower-region/MobileNativeChatFloatingControls'
import { MobileNativeChatEmptyStateView } from '../session/native-chat/transcript/viewport/MobileNativeChatEmptyStateView'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { BotGroupTranscript } from '../../../src/shared/bots/bot-group-transcript'
import { groupStyles as styles } from './mobile-bot-group-styles'
export function MobileBotGroupTranscript({
  groupId,
  data,
  children
}: {
  groupId: string
  data: BotGroupTranscript | null
  children: ReactNode
}) {
  const t = useMobileTranslation()
  const hasItems = Boolean(data?.messages.length)
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
  // A loaded room with no messages yet: its name over desktop's prompt, as an empty chat shows.
  if (data?.messages.length === 0) {
    return (
      <MobileNativeChatEmptyStateView
        copy={{
          title: data.group.name,
          subtitle: t(
            'bots.groups.startAConversationWithThisGroupMentionBots',
            'Start a conversation with this group. Mention bots with @Name or @everyone.'
          )
        }}
      />
    )
  }
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
