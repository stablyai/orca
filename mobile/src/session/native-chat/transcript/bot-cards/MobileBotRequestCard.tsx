// The card Orca leaves in the owner's chat when its bot asks or hands work to another bot: who it went
// to, how it stands and its answer, read from the host as that bot's row changes.
import { useEffect, useState } from 'react'
import { Text } from 'react-native'
import { ArrowUpRight } from 'lucide-react-native'
import {
  botRequestCardView,
  type BotRequestCardView
} from '../../../../../../src/shared/bots/bot-request-card-view'
import type {
  BotRequestCard,
  BotRequestCardReading
} from '../../../../../../src/shared/bots/bot-request-card'
import { useHostBotById, useHostBotStatus } from '../../../../bots/host-bot-store'
import { mobileBotAvatarSource } from '../../../../bots/host-bot-row-facts'
import { MobileBotAvatar } from '../../../../bots/MobileBotAvatar'
import { publishBotLink } from '../../../../bots/pending-bot-link'
import type { Translate } from '../../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { colors, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import type { RpcClient } from '../../../../transport/rpc/rpc-client-contract'
import { scaledType } from '../messages/mobile-native-chat-message-styles'
import { MobileNativeChatNoticePill } from '../notices/MobileNativeChatNoticePill'
import { useMobileNativeChatDisclosure } from '../viewport/mobile-native-chat-disclosure-store'
import { mobileBotRequestSay } from './mobile-bot-card-copy'
import { useMobileBotCardHost } from './mobile-bot-card-host'
import { botRequestOutcomeRead } from './mobile-bot-card-operations'
import { foldMobileBotRequestMail } from './mobile-bot-request-folded-mail'
import {
  BOT_CARD_AVATAR_SIZE,
  MobileBotCardActions,
  MobileBotCardFrame,
  MobileBotCardMeta
} from './MobileBotCardFrame'

const UNREAD: Pick<BotRequestCardReading, 'outcome' | 'answer' | 'chatId'> = {
  outcome: null,
  answer: null,
  chatId: null
}

/** How the asked bot stands, after its name, in the mock's words. */
export function mobileBotRequestStatus(
  view: BotRequestCardView,
  purpose: BotRequestCard['purpose'],
  t: Translate
): string | null {
  if (!view.sent) {
    return null
  }
  switch (view.dot) {
    case 'done':
      return purpose === 'question'
        ? t('chat.botCards.request.answered', '✓ answered')
        : t('chat.botCards.request.done', '✓ done')
    case 'interrupted':
      return t('chat.botCards.request.notAnswered', 'not answered')
    case 'permission':
      return t('chat.botCards.request.waitingOnYou', 'waiting on you')
    case 'working':
      return purpose === 'question'
        ? t('chat.botCards.request.working', 'working…')
        : t('chat.botCards.request.hasIt', 'has it')
    case null:
      return t('chat.botCards.request.hasIt', 'has it')
  }
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

export function MobileBotRequestCard({
  card,
  cardId,
  fallback,
  fontScale
}: {
  card: BotRequestCard
  cardId: string
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
  const [open, setOpen] = useMobileNativeChatDisclosure(`bot-request:${cardId}`, false)
  if (!bot) {
    return (
      <Text style={[styles.fallback, scaledType(typography.bodySize, fontScale)]}>{fallback}</Text>
    )
  }
  const view = botRequestCardView(card, reading, status ?? '', mobileBotRequestSay(t))
  const state = mobileBotRequestStatus(view, card.purpose, t)
  return (
    <MobileBotCardFrame
      avatar={
        <MobileBotAvatar
          avatar={mobileBotAvatarSource(bot, undefined)}
          size={BOT_CARD_AVATAR_SIZE}
        />
      }
      heading={view.heading}
      title={state ? `${bot.name} · ${state}` : bot.name}
      meta={<MobileBotCardMeta fontScale={fontScale}>{view.line}</MobileBotCardMeta>}
      fontScale={fontScale}
      {...(view.answer ? { onToggle: () => setOpen(!open), expanded: open } : {})}
      testID={`bot-request-card:${cardId}`}
    >
      {view.answer ? (
        <Text
          selectable
          numberOfLines={open ? undefined : 4}
          style={[styles.answer, scaledType(typography.bodySize, fontScale)]}
        >
          {view.answer}
        </Text>
      ) : null}
      {view.sent ? (
        <MobileBotCardActions>
          <MobileNativeChatNoticePill
            label={t('chat.botCards.request.openChat', 'Open its chat')}
            Icon={ArrowUpRight}
            onPress={() =>
              // The request's own chat when the host names one other than Home; else Home.
              reading.chatId && reading.chatId !== bot.chatSessionId && host
                ? host.openBotChat(bot, reading.chatId)
                : publishBotLink({ kind: 'bot', botId: bot.id })
            }
          />
        </MobileBotCardActions>
      ) : null}
    </MobileBotCardFrame>
  )
}

const styles = themedStyleSheet(() => ({
  fallback: { color: colors.textMuted },
  answer: { color: colors.textPrimary }
}))
