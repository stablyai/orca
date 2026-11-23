// A bot on a paired computer, asked by mail: its answer when it arrives, else where the question
// stands, in the desktop's words. No live work, tools or approvals show; they stay on that computer.
import { useMemo } from 'react'
import { Text, View } from 'react-native'
import type { BotGroupRemoteAsk } from '../../../src/shared/bots/bot-group'
import { botGroupRemoteAskLines } from '../../../src/shared/bots/bot-group-remote-ask-lines'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileNativeChatBotIdentityContext } from '../session/native-chat/mobile-native-chat-bot-identity'
import { MobileNativeChatRowOverlaysHost } from '../session/native-chat/transcript/message-actions/MobileNativeChatRowOverlaysHost'
import { MobileNativeChatMessage } from '../session/native-chat/transcript/messages/MobileNativeChatMessage'
import { MobileNativeChatTurnStatus } from '../session/native-chat/transcript/messages/MobileNativeChatTurnStatus'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { mobileBotAvatarSource } from './host-bot-row-facts'
import { groupStyles as styles } from './mobile-bot-group-styles'

export function MobileBotGroupRemoteAsk({ ask }: { ask: BotGroupRemoteAsk }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { answer, status, detail, shortened } = botGroupRemoteAskLines(ask, t)
  const conversation = useMemo(
    () => ({ surfaceId: ask.requestId, sessionId: null }),
    [ask.requestId]
  )
  const identity = useMemo(
    () => ({
      name: ask.name,
      // No `id`: an uploaded picture is on that computer, so it shows as letters.
      avatar: mobileBotAvatarSource(ask),
      showName: true
    }),
    [ask]
  )
  return (
    <MobileNativeChatBotIdentityContext.Provider value={identity}>
      <View style={styles.turn}>
        <MobileNativeChatTurnStatus pendingLabel={status} startedAt={null} />
        {detail ? <Text style={styles.notice}>{detail}</Text> : null}
        {answer !== null ? (
          // No image source: a path in the answer is on that computer, not the group's.
          <MobileNativeChatRowOverlaysHost conversation={conversation} linkOpenMode="ask">
            <MobileNativeChatMessage
              message={{
                id: `${ask.requestId}:answer`,
                role: 'assistant',
                blocks: [{ type: 'text', text: answer }],
                timestamp: null,
                source: 'transcript'
              }}
            />
          </MobileNativeChatRowOverlaysHost>
        ) : null}
        {shortened ? <Text style={styles.notice}>{shortened}</Text> : null}
      </View>
    </MobileNativeChatBotIdentityContext.Provider>
  )
}
