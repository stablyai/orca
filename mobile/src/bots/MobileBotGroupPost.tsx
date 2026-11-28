// One post in a group room: the owner's message or a member's request line, the turns it started, and
// its questions to bots on paired computers.
import { View } from 'react-native'
import {
  botGroupOwnerMessageBlocks,
  type BotGroupMessage
} from '../../../src/shared/bots/bot-group'
import { stripSentImagePromptMarkers } from '../../../src/shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import { MobileNativeChatMessage } from '../session/native-chat/transcript/messages/MobileNativeChatMessage'
import { MobileNativeChatMessageTime } from '../session/native-chat/transcript/messages/MobileNativeChatMessageTime'
import { stylesSheet as messageStylesSheet } from '../session/native-chat/transcript/messages/mobile-native-chat-message-styles'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { PhoneBot } from './host-bots-operations'
import { MobileBotGroupPeerRequestLine } from './MobileBotGroupPeerRequestLine'
import { MobileBotGroupRemoteAsk } from './MobileBotGroupRemoteAsk'
import { MobileBotGroupTurn, type MobileBotGroupSession } from './MobileBotGroupTurns'

export function MobileBotGroupPost({
  message,
  client,
  bots,
  sessions,
  onStop,
  onReply
}: {
  message: BotGroupMessage
  client: RpcClient
  bots: readonly PhoneBot[]
  sessions: ReadonlyMap<string, MobileBotGroupSession>
  onStop: (botId: string) => void
  onReply: (botId: string) => void
}) {
  const messageStyles = useThemedStyles(messageStylesSheet)
  const styles = useThemedStyles(stylesSheet)
  return (
    <View>
      {message.author.kind === 'owner' ? (
        <>
          <MobileNativeChatMessage
            message={{
              id: message.id,
              role: 'user',
              // The photos show under the words, so the [Image #N] the send wrote go, as on desktop.
              blocks: botGroupOwnerMessageBlocks({
                ...message,
                text: stripSentImagePromptMarkers(message.text, message.images?.length ?? 0)
              }),
              timestamp: message.createdAt,
              source: 'transcript',
              ...(message.automationRun ? { automationRun: message.automationRun } : {})
            }}
          />
          {/* A room is read later, so your own posts keep their time, as the bots' turns do. */}
          <View style={[messageStyles.meta, styles.ownerTime]}>
            <MobileNativeChatMessageTime timestamp={message.createdAt} fontScale={1} />
          </View>
        </>
      ) : (
        <MobileBotGroupPeerRequestLine message={message} />
      )}
      {message.turns.map((turn) => (
        <MobileBotGroupTurn
          key={turn.operationId}
          turn={turn}
          client={client}
          folderId={bots.find((bot) => bot.id === turn.botId)?.folderWorkspaceId}
          session={sessions.get(turn.sessionId)}
          onStop={() => onStop(turn.botId)}
          onReply={() => onReply(turn.botId)}
        />
      ))}
      {message.remoteAsks?.map((ask) => (
        <MobileBotGroupRemoteAsk key={ask.requestId} ask={ask} />
      ))}
    </View>
  )
}

const stylesSheet = themedStyleSheet(() => ({
  ownerTime: {
    alignSelf: 'flex-end',
    paddingHorizontal: spacing.lg,
    marginTop: -spacing.xs
  }
}))
