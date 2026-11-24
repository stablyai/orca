// One post in a group room: the owner's message or a member's request line, the turns it started, and
// its questions to bots on paired computers.
import { View } from 'react-native'
import {
  botGroupOwnerMessageBlocks,
  type BotGroupMessage
} from '../../../src/shared/bots/bot-group'
import {
  botGroupTurnRows,
  botGroupTurnSilent
} from '../../../src/shared/bots/bot-group-member-turn'
import { stripSentImagePromptMarkers } from '../../../src/shared/native-chat/transcript/images/native-chat-sent-image-prompt-markers'
import { MobileNativeChatMessage } from '../session/native-chat/transcript/messages/MobileNativeChatMessage'
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
  // A member turn that said only the quiet marker told the room nothing: the room keeps no line of it.
  const quiet =
    message.turns.length > 0 &&
    message.turns.every((turn) =>
      botGroupTurnSilent(turn, botGroupTurnRows(turn, sessions.get(turn.sessionId)?.groupTurnItems))
    )
  return (
    <View>
      {message.author.kind === 'owner' ? (
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
      ) : quiet ? null : (
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
