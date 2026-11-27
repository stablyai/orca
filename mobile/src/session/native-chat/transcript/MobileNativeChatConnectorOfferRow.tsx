import { Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import {
  CONNECTOR_OFFER_NAMES,
  type ConnectorOffer,
  type ConnectorOfferSource
} from '../../../../../src/shared/bots/bot-connector-offer'
import { useHostBotById, useHostBotsEntry } from '../../../bots/host-bot-store'
import { useBotPanelOpener } from '../../../bots/bot-item-open'
import type { ConnectorPage } from '../../../bots/connectors/connector-pages'
import type { PhoneBot } from '../../../bots/host-bots-operations'
import { useMobileBotCardHost } from './bot-cards/mobile-bot-card-host'
import {
  MobileBotCardActions,
  MobileBotCardFrame,
  MobileBotCardMeta
} from './bot-cards/MobileBotCardFrame'
import { useMobileBotOfferAnswer } from './bot-cards/use-mobile-bot-offer-answer'
import { MobileNativeChatNoticePill } from './notices/MobileNativeChatNoticePill'
import { MobileConnectorLogo } from '../../../bots/MobileConnectorSourceIcon'
import { MobileGhSignedOutLine } from '../../../bots/connectors/MobileGhSignedOutLine'
import { usePhoneGitHubAccount } from '../../../bots/connectors/use-phone-connector-account'
import { ghSignedOut } from '../../../../../src/shared/connector-bot-github-contract'
import type { Translate } from '../../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { typography } from '../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../theme/themed-styles'
import { useMobileColors } from '../../../theme/use-mobile-color-scheme'
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

const LIST: ConnectorPage = { kind: 'list' }

/** Where the desktop card's Connect (or add access) goes on the phone: the source's setup page, or for a
 *  GitHub already linked, Add a connector, whose GitHub row adds another organization. */
function connectPage(source: ConnectorOfferSource, bot: PhoneBot | null): ConnectorPage {
  switch (source) {
    case 'slack':
      return { kind: 'slack-setup', teamId: undefined, from: LIST }
    case 'linear':
      return { kind: 'linear-setup', workspaceId: undefined, from: LIST }
    case 'github':
      return bot?.github ? { kind: 'add' } : { kind: 'github-setup', from: LIST }
    case 'google':
      return { kind: 'google-connect', from: LIST }
  }
}

/** A bot's Connect card. Connect opens the source's setup in the bot's Settings; Not now answers it here.
 *  Once the bot has the connector, it says so, or that it's paused while its host is signed out. With no
 *  panel to open (an older host), the card says to connect on the computer. */
export function MobileNativeChatConnectorOfferRow({
  offer,
  cardId,
  fontScale
}: {
  offer: ConnectorCardOffer
  cardId: string
  fontScale: number
}): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const bot = useHostBotById(offer.botId)
  const answer = useMobileBotOfferAnswer(offer.botId, cardId)
  const name = CONNECTOR_OFFER_NAMES[offer.source]
  const connected = connectorOfferConnected(bot, offer)
  // The offer is in the bot's own chat, so the chat's host runs it. Google events don't go through Orca Cloud.
  const host = useMobileBotCardHost()
  const cloudStatus = useHostBotsEntry(host?.hostKey ?? null)?.connectorStatus
  const paused = connected && offer.source !== 'google' && cloudStatus === 'signed-out'
  // The host's GitHub read, shared with its Connectors pages, says whether its gh is signed in.
  const github = usePhoneGitHubAccount(
    host?.client ?? null,
    host?.hostKey ?? '',
    connected && offer.source === 'github',
    0
  )
  const ghOut =
    offer.source === 'github' && github.view.status === 'ready' && ghSignedOut(github.view.value)
  const panel = useBotPanelOpener(offer.botId)
  const openSetup = panel ? () => panel.open({ settings: connectPage(offer.source, bot) }) : null
  // As the desktop: an offer naming another workspace of a source the bot has adds that workspace.
  const addsWorkspace =
    offer.workspace !== undefined &&
    connectorOfferConnected(bot, { ...offer, workspace: undefined })
  const connectLabel = addsWorkspace
    ? offer.source === 'github'
      ? t('bots.connectors.addOrg', 'Add org')
      : t('bots.connectors.addWorkspace', 'Add workspace')
    : t('bots.connectorOffer.connect', 'Connect {{service}}', { service: name })
  const meta = (text: string) => (
    <MobileBotCardMeta fontScale={fontScale} lines={3}>
      {text}
    </MobileBotCardMeta>
  )
  return (
    <MobileBotCardFrame
      avatar={<MobileConnectorLogo source={offer.source} />}
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
          {ghOut && host ? (
            <MobileGhSignedOutLine host={host.hostLabel} card={{ fontScale }} />
          ) : null}
          {/* As the desktop card's add action. */}
          {offer.addAccess && offer.source !== 'google' ? (
            openSetup ? (
              <MobileBotCardActions>
                <MobileNativeChatNoticePill
                  label={
                    offer.source === 'github'
                      ? t('bots.connectors.addGitHubAccess', 'Add repositories or organizations')
                      : t('bots.connectors.addAnotherWorkspace', 'Add another workspace')
                  }
                  onPress={openSetup}
                />
              </MobileBotCardActions>
            ) : (
              meta(
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
            )
          ) : null}
        </>
      ) : (
        <>
          {openSetup
            ? null
            : meta(
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
              {openSetup ? (
                <MobileNativeChatNoticePill label={connectLabel} primary onPress={openSetup} />
              ) : null}
            </MobileBotCardActions>
          )}
        </>
      )}
    </MobileBotCardFrame>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  connected: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  detail: { color: colors.textMuted },
  error: { color: colors.statusRed }
}))
