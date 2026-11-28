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
import { groupStylesSheet } from './mobile-bot-group-styles'
import { MobileBotFaceStack } from './MobileBotFaceStack'
import type { MobileBotAvatarSource } from './host-bot-row-facts'
import type { Translate } from '../i18n/mobile-i18n'
import { useThemedStyles } from '../theme/themed-styles'

const READER_SCROLL_MS = 300
const EMPTY_FACES = 34
/** Names an empty room lists before "and N more". */
const NAMED = 3

/** "A, B and C", or "A, B, C and 2 more". */
function memberNames(members: readonly { name: string }[], t: Translate): string {
  const names = members.map((member) => member.name)
  const listed = names.length > NAMED ? names.slice(0, NAMED) : names.slice(0, -1)
  const last =
    names.length > NAMED
      ? t('bots.groups.moreCount', '{{count}} more', { count: names.length - NAMED })
      : names.at(-1)
  return listed.length === 0
    ? (last ?? '')
    : t('bots.groups.andNames', '{{names}} and {{last}}', { names: listed.join(', '), last })
}

export function MobileBotGroupTranscript({
  client,
  roomId,
  data,
  members,
  children
}: {
  client: RpcClient
  /** The group's id for its original room, a thread's id for that thread. */
  roomId: string
  data: BotGroupTranscript | null
  /** Who is in the room, for its empty state. */
  members: readonly { id: string; name: string; avatar: MobileBotAvatarSource }[]
  children: ReactNode
}) {
  const styles = useThemedStyles(groupStylesSheet)
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
  // A loaded room with no messages yet: who is in it, its name, and their names, as an empty chat shows.
  if (data?.messages.length === 0) {
    return (
      <MobileNativeChatEmptyStateView
        picture={<MobileBotFaceStack faces={members} slot={EMPTY_FACES} />}
        copy={{
          title:
            roomId === data.group.id
              ? data.group.name
              : t('bots.groups.newThread', 'New thread in {{name}}', { name: data.group.name }),
          // The bots list may not have loaded yet; no names is better than " are here."
          subtitle:
            members.length > 0
              ? t('bots.groups.membersHere', '{{names}} are here.', {
                  names: memberNames(members, t),
                  count: members.length
                })
              : ''
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
