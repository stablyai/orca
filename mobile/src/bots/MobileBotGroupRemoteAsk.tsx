// A bot on a paired computer, asked by mail: its answer when it arrives, else one quiet line saying where
// the question stands, in the desktop's words. No live work, tools or approvals show; they stay on that computer.
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
import { MobileBotAvatar } from './MobileBotAvatar'
import {
  MobileNativeChatEventName,
  MobileNativeChatEventRow
} from '../session/native-chat/transcript/messages/MobileNativeChatEventRow'
import { styles as messageStyles } from '../session/native-chat/transcript/messages/mobile-native-chat-message-styles'
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
  if (answer === null) {
    return (
      <View style={messageStyles.row}>
        <MobileNativeChatEventRow
          icon={<MobileBotAvatar avatar={identity.avatar} size={14} />}
          label={`${ask.name} · ${status}`}
          details={detail ? <Text style={styles.label}>{detail}</Text> : null}
          disclosureKey={`group-remote-ask:${ask.requestId}`}
          fontScale={1}
          wordsLines={2}
        >
          <MobileNativeChatEventName>{ask.name}</MobileNativeChatEventName> · {status}
        </MobileNativeChatEventRow>
      </View>
    )
  }
  return (
    <MobileNativeChatBotIdentityContext.Provider value={identity}>
      <View style={styles.turn}>
        <MobileNativeChatTurnStatus pendingLabel={status} startedAt={null} />
        {/* No image source: a path in the answer is on that computer, not the group's. */}
        <MobileNativeChatRowOverlaysHost conversation={conversation} linkOpenMode="ask">
          <MobileNativeChatMessage
            message={{
              id: `${ask.requestId}:answer`,
              role: 'assistant',
              blocks: [{ type: 'text', text: answer }],
              timestamp: null,
              source: 'transcript'
            }}
            withoutMeta
          />
        </MobileNativeChatRowOverlaysHost>
        {shortened ? <Text style={[styles.notice, styles.turnNotice]}>{shortened}</Text> : null}
      </View>
    </MobileNativeChatBotIdentityContext.Provider>
  )
}
