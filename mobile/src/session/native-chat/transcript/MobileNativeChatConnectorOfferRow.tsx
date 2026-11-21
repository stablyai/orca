import { Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import {
  CONNECTOR_OFFER_NAMES,
  type ConnectorOffer,
  type ConnectorOfferSource
} from '../../../../../src/shared/bots/bot-connector-offer'
import { useHostBotById, useHostBotsEntry } from '../../../bots/host-bot-store'
import type { PhoneBot } from '../../../bots/host-bots-operations'
import { useMobileBotCardHost } from './bot-cards/mobile-bot-card-host'
import {
  MobileBotCardActions,
  MobileBotCardFrame,
  MobileBotCardMeta
} from './bot-cards/MobileBotCardFrame'
import { useMobileBotOfferAnswer } from './bot-cards/use-mobile-bot-offer-answer'
import { MobileNativeChatNoticePill } from './notices/MobileNativeChatNoticePill'
import {
  MobileGoogleMark,
  MobileConnectorSourceIcon
} from '../../../bots/MobileConnectorSourceIcon'
import type { Translate } from '../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, typography } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { scaledType } from './messages/mobile-native-chat-message-styles'

type ConnectorCardOffer = ConnectorOffer & { source: ConnectorOfferSource }

/** A card for a connector; a sign-in or webhook offer is painted as its plain text line. */
export function isConnectorCardOffer(offer: ConnectorOffer): offer is ConnectorCardOffer {
  return !offer.signIn && offer.source !== 'webhook'
}

/** As the desktop's card: an offer naming a workspace is connected once the bot is in that one. The
 *  phone knows only Linear's workspace names; Slack's and GitHub's are read on the computer. */
export function connectorOfferConnected(bot: PhoneBot | null, offer: ConnectorCardOffer): boolean {
  // The phone can't see the computer's Google sign-in, so the owner's toggle is all it reads.
  if (offer.source === 'google') {
    return bot?.google === true
  }
  if (!bot || bot[offer.source] == null) {
    return false
  }
  const wanted = offer.workspace?.toLowerCase()
  if (!wanted) {
    return true
  }
  return (
    offer.source === 'linear' &&
    (bot.linearWorkspaces ?? (bot.linear ? [bot.linear] : [])).some(
      (entry) => entry.workspaceName.toLowerCase() === wanted
    )
  )
}

// As the desktop's card, AddConnectorDialog's line for the source.
function connectorDescription(t: Translate, source: ConnectorOfferSource): string {
  switch (source) {
    case 'slack':
      return t(
        'bots.connectorOffer.slack',
        'Chat with the bot from Slack channels and direct messages.'
      )
    case 'google':
      return t(
        'bots.connectorOffer.google',
        'Let the bot work in your Gmail, Calendar and Drive, and start automations on new mail.'
      )
    case 'linear':
      return t(
        'bots.connectorOffer.linear',
        'Hand the bot issues by @mentioning or assigning it, and start automations on Linear events.'
      )
    case 'github':
      return t(
        'bots.connectorOffer.github',
        'Hand the bot work by @mentioning it, and start automations on GitHub events.'
      )
  }
}

/** A bot's Connect card. Connecting happens on the computer, so the phone says where; Not now answers it
 *  here. Once the bot has the connector, it says so, or that it's paused while its host is signed out. */
export function MobileNativeChatConnectorOfferRow({
  offer,
  cardId,
  fontScale
}: {
  offer: ConnectorCardOffer
  cardId: string
  fontScale: number
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const bot = useHostBotById(offer.botId)
  const answer = useMobileBotOfferAnswer(offer.botId, cardId)
  const name = CONNECTOR_OFFER_NAMES[offer.source]
  const connected = connectorOfferConnected(bot, offer)
  // The offer is in the bot's own chat, so the chat's host runs it. Google events don't go through Orca Cloud.
  const host = useMobileBotCardHost()
  const cloudStatus = useHostBotsEntry(host?.hostKey ?? null)?.connectorStatus
  const paused = connected && offer.source !== 'google' && cloudStatus === 'signed-out'
  const meta = (text: string) => (
    <MobileBotCardMeta fontScale={fontScale} lines={3}>
      {text}
    </MobileBotCardMeta>
  )
  return (
    <MobileBotCardFrame
      avatar={
        offer.source === 'google' ? (
          <MobileGoogleMark />
        ) : (
          <MobileConnectorSourceIcon source={offer.source} />
        )
      }
      heading={t('bots.connectorOffer.heading', 'Connect a service')}
      title={offer.workspace ? `${name} · ${offer.workspace}` : name}
      meta={connected ? null : meta(connectorDescription(t, offer.source))}
      fontScale={fontScale}
    >
      {paused ? (
        meta(
          t('bots.connectorOffer.paused', 'Paused until {{host}} signs in to Orca.', {
            host: host?.hostLabel
          })
        )
      ) : connected ? (
        <>
          <View style={styles.connected}>
            <Check size={12} color={colors.textMuted} />
            <Text style={[styles.detail, scaledType(typography.metaSize, fontScale)]}>
              {t('bots.connectorOffer.connected', 'Connected')}
            </Text>
          </View>
          {/* As the desktop card's add action, which the phone points to. */}
          {offer.addAccess && offer.source !== 'google'
            ? meta(
                offer.source === 'github'
                  ? t(
                      'bots.connectorOffer.addGitHubAccess',
                      'Add repositories or organizations in Orca on your computer, from the card in this chat.'
                    )
                  : t(
                      'bots.connectorOffer.addWorkspace',
                      'Add another workspace in Orca on your computer, from the card in this chat.'
                    )
              )
            : null}
        </>
      ) : (
        <>
          {meta(
            t(
              'bots.connectorOffer.onComputer',
              'Connect it in Orca on your computer, from the card in this chat.'
            )
          )}
          {answer.error ? (
            <Text style={[styles.error, scaledType(typography.metaSize, fontScale)]}>
              {answer.error}
            </Text>
          ) : null}
          {answer.dismissed ? null : (
            <MobileBotCardActions>
              <MobileNativeChatNoticePill
                label={t('chat.botCards.offer.notNow', 'Not now')}
                disabled={!answer.ready}
                onPress={answer.dismiss}
              />
            </MobileBotCardActions>
          )}
        </>
      )}
    </MobileBotCardFrame>
  )
}

const styles = themedStyleSheet(() => ({
  connected: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  detail: { color: colors.textMuted },
  error: { color: colors.statusRed }
}))
