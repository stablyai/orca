import { StyleSheet, Text, View } from 'react-native'
import { Check } from 'lucide-react-native'
import {
  CONNECTOR_OFFER_NAMES,
  type ConnectorOffer,
  type ConnectorOfferSource
} from '../../../../../src/shared/bots/bot-connector-offer'
import { useHostBotById } from '../../../bots/host-bot-store'
import type { PhoneBot } from '../../../bots/host-bots-operations'
import {
  MobileGoogleMark,
  MobileConnectorSourceIcon
} from '../../../bots/MobileConnectorSourceIcon'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import { colors, radii, spacing, typography } from '../../../theme/mobile-theme'
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

/** A bot's Connect card. Connecting happens on the computer, so the phone says where; once the bot has
 *  the connector, it says so. */
export function MobileNativeChatConnectorOfferRow({
  offer,
  fontScale
}: {
  offer: ConnectorCardOffer
  fontScale: number
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const bot = useHostBotById(offer.botId)
  const name = CONNECTOR_OFFER_NAMES[offer.source]
  const connected = connectorOfferConnected(bot, offer)
  return (
    <View style={styles.card} accessibilityRole="text">
      <View style={styles.icon}>
        {offer.source === 'google' ? (
          <MobileGoogleMark />
        ) : (
          <MobileConnectorSourceIcon source={offer.source} />
        )}
      </View>
      <View style={styles.body}>
        <Text style={[styles.title, scaledType(typography.bodySize, fontScale)]}>
          {offer.workspace ? `${name} · ${offer.workspace}` : name}
        </Text>
        {connected ? (
          <>
            <View style={styles.connected}>
              <Check size={12} color={colors.textMuted} />
              <Text style={[styles.detail, scaledType(typography.metaSize, fontScale)]}>
                {t('bots.connectorOffer.connected', 'Connected')}
              </Text>
            </View>
            {/* As the desktop card's add action, which the phone points to. */}
            {offer.addAccess && offer.source !== 'google' ? (
              <Text style={[styles.detail, scaledType(typography.metaSize, fontScale)]}>
                {offer.source === 'github'
                  ? t(
                      'bots.connectorOffer.addGitHubAccess',
                      'Add repositories or organizations in Orca on your computer, from the card in this chat.'
                    )
                  : t(
                      'bots.connectorOffer.addWorkspace',
                      'Add another workspace in Orca on your computer, from the card in this chat.'
                    )}
              </Text>
            ) : null}
          </>
        ) : (
          <Text style={[styles.detail, scaledType(typography.metaSize, fontScale)]}>
            {t(
              'bots.connectorOffer.onComputer',
              'Connect it in Orca on your computer, from the card in this chat.'
            )}
          </Text>
        )}
      </View>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle
  },
  icon: { paddingTop: 2 },
  body: { flex: 1, gap: 2 },
  title: { color: colors.textPrimary, fontWeight: '600' },
  connected: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  detail: { color: colors.textMuted }
}))
