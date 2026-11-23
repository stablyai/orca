import { useCallback, useMemo, useRef, type ReactNode } from 'react'
import { Platform, ScrollView, View, type ScrollViewInstance } from 'react-native'
import { folderWorkspaceKey } from '../../../src/shared/workspace/identity/workspace-scope'
import {
  distanceFromTail,
  useMobileNativeChatTailFollow
} from '../session/native-chat/transcript/viewport/use-mobile-native-chat-tail-follow'
import { MobileNativeChatFloatingControls } from '../session/native-chat/lower-region/MobileNativeChatFloatingControls'
import { MobileNativeChatEmptyStateView } from '../session/native-chat/transcript/viewport/MobileNativeChatEmptyStateView'
import { MobileNativeChatRowOverlaysHost } from '../session/native-chat/transcript/message-actions/MobileNativeChatRowOverlaysHost'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { BotGroupTranscript } from '../../../src/shared/bots/bot-group-transcript'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { groupStyles as styles } from './mobile-bot-group-styles'
const READER_SCROLL_MS = 300

export function MobileBotGroupTranscript({
  client,
  roomId,
  data,
  children
}: {
  client: RpcClient
  /** The group's id for its original room, a thread's id for that thread. */
  roomId: string
  data: BotGroupTranscript | null
  children: ReactNode
}) {
  const t = useMobileTranslation()
  const hasItems = Boolean(data?.messages.length)
  const tail = useMobileNativeChatTailFollow({ scopeKey: roomId, hasItems })
  const attach = tail.listProps.ref
  // The page's ScrollView reports no drags, so a scroll right after the reader's touch is theirs.
  const readerAt = useRef(0)
  const noteReader = () => {
    readerAt.current = Date.now()
  }
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
  const folderId = data?.group.folderWorkspaceId
  const conversation = useMemo(() => ({ surfaceId: `group:${roomId}`, sessionId: null }), [roomId])
  const imageSource = useMemo(
    () => (folderId ? { client, worktreeId: folderWorkspaceKey(folderId) } : undefined),
    [client, folderId]
  )
  // A loaded room with no messages yet: its name over desktop's prompt, as an empty chat shows.
  if (data?.messages.length === 0) {
    return (
      <MobileNativeChatEmptyStateView
        copy={{
          title:
            roomId === data.group.id
              ? data.group.name
              : t('bots.groups.newThread', 'New thread in {{name}}', { name: data.group.name }),
          subtitle: t(
            'bots.groups.startAConversationWithThisGroupMentionBots',
            'Start a conversation with this group. Mention bots with @Name or @everyone.'
          )
        }}
      />
    )
  }
  return (
    <MobileNativeChatRowOverlaysHost
      conversation={conversation}
      imageSource={imageSource}
      linkOpenMode="ask"
    >
      <View style={styles.grow}>
        <ScrollView
          ref={ref}
          keyboardShouldPersistTaps="handled"
          style={styles.grow}
          contentContainerStyle={styles.transcript}
          onContentSizeChange={tail.pinToTailAfterContentResize}
          onLayout={tail.pinToTail}
          onScroll={(event) =>
            Platform.OS === 'web'
              ? tail.pageListProps.onEndDistance(
                  distanceFromTail(event.nativeEvent),
                  Date.now() - readerAt.current < READER_SCROLL_MS
                )
              : tail.recordScrollMetrics(event.nativeEvent)
          }
          onTouchMove={noteReader}
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
    </MobileNativeChatRowOverlaysHost>
  )
}
