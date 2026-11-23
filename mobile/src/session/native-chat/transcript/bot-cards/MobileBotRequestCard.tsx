// The row Orca leaves in the owner's chat when its bot asks or hands work to another bot: who it went
// to, how it stands and its answer, read from the host as that bot's row changes.
import { useEffect, useState } from 'react'
import { Pressable, Text } from 'react-native'
import { ArrowUpRight, Send } from 'lucide-react-native'
import { botRequestCardView } from '../../../../../../src/shared/bots/bot-request-card-view'
import type {
  BotRequestCard,
  BotRequestCardReading
} from '../../../../../../src/shared/bots/bot-request-card'
import { useHostBotById, useHostBotStatus } from '../../../../bots/host-bot-store'
import { publishBotLink } from '../../../../bots/pending-bot-link'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, pressedStyle, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import {
  MobileNativeChatEventName,
  MobileNativeChatEventRow
} from '../messages/MobileNativeChatEventRow'
import { scaledType } from '../messages/mobile-native-chat-message-styles'
import { mobileBotRequestSay } from './mobile-bot-card-copy'
import { useMobileBotCardHost } from './mobile-bot-card-host'
import { botRequestOutcomeRead } from './mobile-bot-card-operations'
import { foldMobileBotRequestMail } from './mobile-bot-request-folded-mail'

const UNREAD: Pick<BotRequestCardReading, 'outcome' | 'answer' | 'chatId'> = {
  outcome: null,
  answer: null,
  chatId: null
}

/** The host's reading of a sent request; reread as the asked bot's row changes, until it's answered. */
function useRequestReading(
  client: RpcClient | null,
  messageId: string | undefined,
  rereadKey: string
): Pick<BotRequestCardReading, 'outcome' | 'answer' | 'chatId'> {
  const [reading, setReading] = useState(UNREAD)
  const settled = reading.outcome === 'answered' && reading.answer !== null
  useEffect(() => {
    if (settled || !messageId || !client) {
      return
    }
    let live = true
    void botRequestOutcomeRead
      .request(client, { messageId })
      .then((response) => {
        const result = botRequestOutcomeRead.interpret(response)
        foldMobileBotRequestMail(result.mailIds ?? [])
        if (live) {
          setReading({
            outcome: result.outcome,
            answer: result.answer,
            chatId: result.chatId ?? null
          })
        }
      })
      // Unread, the card shows what it was sent with; the next change reads again.
      .catch(() => {})
    return () => {
      live = false
    }
  }, [client, messageId, rereadKey, settled])
  return reading
}

const SEND_ICON = <Send size={14} color={colors.textMuted} strokeWidth={2} />

export function MobileBotRequestCard({
  card,
  cardId,
  timestamp,
  fallback,
  fontScale
}: {
  card: BotRequestCard
  cardId: string
  timestamp: number | null
  /** The host's line, for a bot this phone doesn't list. */
  fallback: string
  fontScale: number
}): React.JSX.Element {
  const t = useMobileTranslation()
  const host = useMobileBotCardHost()
  const bot = useHostBotById(card.toBotId)
  const status = useHostBotStatus(card.toBotId)
  const reading = useRequestReading(
    host?.client ?? null,
    card.messageId,
    `${status}:${bot?.paused}:${bot?.chatSessionId}`
  )
  if (!bot) {
    return (
      <MobileNativeChatEventRow
        icon={SEND_ICON}
        badge={card.messageId ? null : 'failed'}
        label={fallback}
        timestamp={timestamp}
        fontScale={fontScale}
      >
        {fallback}
      </MobileNativeChatEventRow>
    )
  }
  const view = botRequestCardView(card, reading, status ?? '', mobileBotRequestSay(t))
  const subject = view.sent ? card.subject : ''
  const answer = scaledType(typography.bodySize, fontScale)
  // The request's own chat when the host names one other than Home; else Home.
  const openChat = () =>
    reading.chatId && reading.chatId !== bot.chatSessionId && host
      ? host.openBotChat(bot, reading.chatId)
      : publishBotLink({ kind: 'bot', botId: bot.id })
  return (
    <MobileNativeChatEventRow
      testID={`bot-request-card:${cardId}`}
      icon={SEND_ICON}
      badge={view.badge}
      label={[`${view.heading} ${bot.name}`, subject].filter(Boolean).join(' · ')}
      action={
        view.sent ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('chat.agentMessage.open', 'Open {{name}}', { name: bot.name })}
            hitSlop={12}
            onPress={openChat}
            style={({ pressed }) => pressed && pressedStyle}
          >
            <ArrowUpRight size={14} color={colors.textMuted} />
          </Pressable>
        ) : null
      }
      timestamp={timestamp}
      disclosureKey={`bot-request:${cardId}`}
      fontScale={fontScale}
      details={
        view.sent ? (
          view.answer ? (
            <Text selectable style={[styles.answer, answer]}>
              {view.answer}
            </Text>
          ) : null
        ) : (
          <>
            <Text style={[styles.answer, answer]}>{view.line}</Text>
            {card.subject ? <Text style={[styles.subject, answer]}>{card.subject}</Text> : null}
          </>
        )
      }
    >
      {view.heading} <MobileNativeChatEventName>{bot.name}</MobileNativeChatEventName>
      {subject ? ` · ${subject}` : null}
    </MobileNativeChatEventRow>
  )
}

const styles = themedStyleSheet(() => ({
  answer: { color: colors.textPrimary },
  subject: { color: colors.textMuted }
}))
