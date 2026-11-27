// The row Orca leaves in the owner's chat when its bot asks or hands work to another bot: who it went
// to, how it stands and its answer, read from the host as that bot's row changes. One sent to an agent
// on a computer paired to the chat's host names that computer and rereads with the host's changes.
import { useEffect, useState } from 'react'
import { Pressable, Text } from 'react-native'
import { ArrowUpRight, Send } from 'lucide-react-native'
import { botRequestCardView } from '../../../../../../src/shared/bots/bot-request-card-view'
import type {
  BotRequestCard,
  BotRequestCardReading
} from '../../../../../../src/shared/bots/bot-request-card'
import { useHostBotById, useHostBotStatus } from '../../../../bots/host-bot-store'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, pressedStyle, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { subscribeSharedClientEvents } from '../../../../transport/connection/shared-client-events'
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

/** The host's reading of a sent request; reread as the asked bot's row changes, until it's answered.
 *  `onClient`: asked of an agent on a paired computer, read from the host's record of the ask with each
 *  bot change and returned peer mail there, until it ends, as the desktop does. */
function useRequestReading(
  client: RpcClient | null,
  messageId: string | undefined,
  rereadKey: string,
  onClient = false
): Pick<BotRequestCardReading, 'outcome' | 'answer' | 'chatId'> {
  const [reading, setReading] = useState(UNREAD)
  const settled = onClient
    ? reading.outcome !== null
    : reading.outcome === 'answered' && reading.answer !== null
  useEffect(() => {
    if (settled || !messageId || !client) {
      return
    }
    let live = true
    const read = (): void =>
      void botRequestOutcomeRead
        .request(client, onClient ? { messageId, onClient } : { messageId })
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
    if (!onClient) {
      read()
      return () => {
        live = false
      }
    }
    // Its answer comes back as peer mail, also on a host with no bots to announce a change.
    const stop = subscribeSharedClientEvents(client, (event) => {
      if (
        event.type === 'ready' ||
        event.type === 'botsChanged' ||
        event.type === 'peerMailReturned'
      ) {
        read()
      }
    })
    return () => {
      live = false
      stop()
    }
  }, [client, messageId, rereadKey, settled, onClient])
  return reading
}

const SEND_ICON = <Send size={14} color={colors.textMuted} strokeWidth={2} />

type RequestRowProps = {
  card: BotRequestCard
  cardId: string
  timestamp: number | null
  fontScale: number
}

/** A request to an agent on a computer paired to the chat's host: the same row, naming that computer,
 *  in the desktop's words for how it stands (NativeChatClientAskRequestCard). */
function ClientAskRequestRow({
  card,
  client,
  cardId,
  timestamp,
  fontScale
}: RequestRowProps & { client: NonNullable<BotRequestCard['client']> }): React.JSX.Element {
  const t = useMobileTranslation()
  const reading = useRequestReading(
    useMobileBotCardHost()?.client ?? null,
    card.messageId,
    '',
    true
  )
  const computer = client.computer || t('chat.botCards.request.pairedComputer', 'Paired computer')
  const view = botRequestCardView(card, reading, '', mobileBotRequestSay(t))
  const state = !view.sent
    ? t('chat.botCards.request.notConnected', 'Wasn’t connected')
    : reading.outcome === 'dropped'
      ? // A notice that it went unanswered shows as its details instead.
        view.answer
        ? null
        : t('chat.botCards.request.declined', 'Declined')
      : reading.outcome === null
        ? t('chat.botCards.request.waitingOn', 'Waiting for approval on {{computer}}', {
            computer
          })
        : null
  const text = scaledType(typography.bodySize, fontScale)
  return (
    <MobileNativeChatEventRow
      testID={`bot-request-card:${cardId}`}
      icon={SEND_ICON}
      badge={
        !view.sent || reading.outcome === 'dropped' ? 'failed' : reading.outcome ? null : 'running'
      }
      label={[`${view.heading} ${card.toBotName}`, card.subject, state].filter(Boolean).join(' · ')}
      timestamp={timestamp}
      disclosureKey={cardId ? `bot-request:${cardId}` : undefined}
      fontScale={fontScale}
      details={
        view.answer ? (
          <Text selectable style={[styles.answer, text]}>
            {view.answer}
          </Text>
        ) : card.subject ? (
          <Text style={[styles.subject, text]}>{card.subject}</Text>
        ) : null
      }
    >
      {view.heading} <MobileNativeChatEventName>{card.toBotName}</MobileNativeChatEventName>
      {` · ${computer}`}
      {card.subject ? ` · ${card.subject}` : null}
      {state ? ` · ${state}` : null}
    </MobileNativeChatEventRow>
  )
}

export function MobileBotRequestCard({
  fallback,
  ...props
}: RequestRowProps & {
  /** The host's line, for a bot this phone doesn't list. */
  fallback: string
}): React.JSX.Element {
  // The asked agent lives on the paired computer, never in this host's list.
  return props.card.client ? (
    <ClientAskRequestRow {...props} client={props.card.client} />
  ) : (
    <HostBotRequestRow {...props} fallback={fallback} />
  )
}

function HostBotRequestRow({
  card,
  cardId,
  timestamp,
  fallback,
  fontScale
}: RequestRowProps & { fallback: string }): React.JSX.Element {
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
  const openChat = host
    ? () =>
        reading.chatId && reading.chatId !== bot.chatSessionId
          ? host.openBotChat(bot, reading.chatId)
          : host.openBotHome(bot)
    : null
  return (
    <MobileNativeChatEventRow
      testID={`bot-request-card:${cardId}`}
      icon={SEND_ICON}
      badge={view.badge}
      label={[`${view.heading} ${bot.name}`, subject].filter(Boolean).join(' · ')}
      action={
        view.sent && openChat ? (
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
      disclosureKey={cardId ? `bot-request:${cardId}` : undefined}
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
