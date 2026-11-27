// A Composio setup card in a bot's chat, as the desktop's ComposioSetupChatCard: drawn from the host's
// Composio state (the key and the bot's sign-ins), so it moves on as things change on any device.
// Composio's own pages are ordinary web pages, so the phone opens them in the browser.
import { useState } from 'react'
import { Text } from 'react-native'
import { Check, ExternalLink, KeyRound } from 'lucide-react-native'
import { COMPOSIO_PAGES } from '../../../../../../src/shared/composio/composio-apps'
import type { ComposioSetupCardRef } from '../../../../../../src/shared/composio/composio-setup-card'
import { useHostBotById } from '../../../../bots/host-bot-store'
import { useBotPanelOpener } from '../../../../bots/bot-item-open'
import { TextField } from '../../../../components/composer-input/TextField'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { openExternalLink } from '../../../../platform/external-links/external-link'
import { typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../../theme/themed-styles'
import { scaledType } from '../messages/mobile-native-chat-message-styles'
import { MobileNativeChatNoticePill } from '../notices/MobileNativeChatNoticePill'
import { MobileBotCardActions } from './MobileBotCardFrame'
import { useMobileBotCardHost } from './mobile-bot-card-host'
import { composioDeclineKey, composioSetKey } from './mobile-composio-operations'
import { rereadMobileComposio, useMobileComposio } from './mobile-composio-store'
import {
  composioHeading,
  composioStep,
  useComposioCall,
  type MobileComposioScope
} from './MobileComposioCardParts'
import { MobileComposioConnectCard } from './MobileComposioConnectCard'
import { MobileComposioEventsCard } from './MobileComposioEventsCard'
import {
  MobileGoogleSetupError,
  MobileGoogleSetupFrame,
  MobileGoogleSetupMuted,
  MobileGoogleSetupOnComputer,
  MobileGoogleSetupReceipt
} from './MobileGoogleSetupCardParts'
import { composerInputStylesSheet } from '../../../../components/composer-input/composer-input-styles'
import { useMobileColors } from '../../../../theme/use-mobile-color-scheme'

function KeyCard({
  scope,
  hostLabel
}: {
  scope: MobileComposioScope
  hostLabel: string
}): React.JSX.Element {
  const composerInputStyles = useThemedStyles(composerInputStylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const { client, hostKey, card, view, fontScale } = scope
  const [changing, setChanging] = useState(false)
  const [declined, setDeclined] = useState(false)
  const [key, setKey] = useState('')
  const { busy, error, run } = useComposioCall()
  const added = view.status?.key === 'ok'
  const rejected = view.status?.key === 'rejected'
  const asking = (!added && !declined) || changing
  const trimmed = key.trim()
  const save = () =>
    void run(async () => {
      // A setup card's key moves its bot's chat on; Change key only replaces it.
      const from = added ? {} : { botId: card.botId, ...(card.app ? { app: card.app } : {}) }
      composioSetKey.interpret(await composioSetKey.request(client, { key: trimmed, ...from }))
      setKey('')
      setChanging(false)
      rereadMobileComposio(hostKey, card.botId)
    })
  const decline = () => {
    setDeclined(true)
    void run(async () => {
      composioDeclineKey.interpret(await composioDeclineKey.request(client, { botId: card.botId }))
    }).then((ok) => !ok && setDeclined(false))
  }
  const receipt =
    added && !changing ? (
      <MobileGoogleSetupReceipt
        text={t('chat.botCards.composio.keyAdded', '✓ Key added')}
        onChange={() => setChanging(true)}
        fontScale={fontScale}
      />
    ) : declined && !added ? (
      <MobileGoogleSetupReceipt
        text={t('chat.botCards.composio.declined', 'Dismissed')}
        onChange={() => setDeclined(false)}
        fontScale={fontScale}
      />
    ) : null
  return (
    <MobileGoogleSetupFrame
      titleLines={2}
      avatar={<KeyRound size={14} color={colors.textMuted} />}
      heading={composioHeading(t)}
      trailing={composioStep(t, card)}
      title={
        rejected
          ? t('chat.botCards.composio.keyRejectedTitle', 'Replace your Composio key')
          : t('chat.botCards.composio.keyTitle', 'Add your Composio key')
      }
      meta={
        rejected
          ? t(
              'chat.botCards.composio.keyRejectedNote',
              'Composio no longer accepts the saved key. Make a new one in Composio under Settings, API Keys.'
            )
          : null
      }
      fontScale={fontScale}
    >
      {asking ? (
        <>
          <TextField
            accessibilityLabel={t('chat.botCards.composio.keyLabel', 'Composio API key')}
            placeholder={t('chat.botCards.composio.keyPlaceholder', 'Paste your key')}
            value={key}
            onChangeText={setKey}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            monospace
            editable={!busy}
            onSubmitEditing={trimmed && !busy ? save : undefined}
            style={composerInputStyles.filledField}
          />
          <MobileGoogleSetupMuted
            text={
              hostLabel
                ? t(
                    'chat.botCards.composio.keyPurposeOnHost',
                    'Your Composio project key lets the bots on {{host}} use the apps you connect there. It stays on {{host}}; bots never see it.',
                    { host: hostLabel }
                  )
                : t(
                    'chat.botCards.composio.keyPurpose',
                    'Your Composio project key lets your bots use the apps you connect there. It stays on your computer; bots never see it.'
                  )
            }
            fontScale={fontScale}
          />
          <MobileGoogleSetupError text={error} fontScale={fontScale} />
          <MobileBotCardActions>
            <MobileNativeChatNoticePill
              label={
                busy
                  ? t('chat.botCards.composio.checking', 'Checking…')
                  : added || rejected
                    ? t('chat.botCards.composio.replaceKey', 'Replace key')
                    : t('chat.botCards.composio.addKey', 'Add key')
              }
              primary
              disabled={busy || !trimmed}
              onPress={save}
            />
            <MobileNativeChatNoticePill
              label={t('chat.botCards.composio.getKey', 'Get a key')}
              Icon={ExternalLink}
              onPress={() => openExternalLink(COMPOSIO_PAGES.apiKeys)}
            />
            {changing ? (
              <MobileNativeChatNoticePill
                label={t('chat.botCards.composio.cancel', 'Cancel')}
                disabled={busy}
                onPress={() => setChanging(false)}
              />
            ) : null}
            {added ? null : (
              <MobileNativeChatNoticePill
                label={t('chat.botCards.composio.dismiss', 'Dismiss')}
                disabled={busy}
                onPress={decline}
              />
            )}
          </MobileBotCardActions>
        </>
      ) : (
        <MobileGoogleSetupError text={error} fontScale={fontScale} />
      )}
      {receipt}
    </MobileGoogleSetupFrame>
  )
}

function ReadyCard({ scope }: { scope: MobileComposioScope }): React.JSX.Element | null {
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const { card, view, botName, fontScale } = scope
  const panel = useBotPanelOpener(card.botId)
  const app = card.app
  if (!app) {
    return null
  }
  const signIns = view.connections?.connections.filter((entry) => entry.app === app.slug) ?? []
  const connection = signIns.find((entry) => entry.status === 'active')
  // The card was true when written; the key, the bot's tool or the sign-in may be gone since.
  const gone =
    view.status !== null &&
    (view.status.key !== 'ok' || !view.status.added || (signIns.length > 0 && !connection))
  return (
    <MobileGoogleSetupFrame
      titleLines={2}
      avatar={<Check size={14} color={colors.textMuted} />}
      heading={
        gone
          ? t('chat.botCards.composio.goneHeading', 'Needs setup')
          : t('chat.botCards.composio.ready', 'Ready')
      }
      title={
        gone
          ? t('chat.botCards.composio.goneTitle', '{{bot}} can’t use {{app}} now', {
              bot: botName,
              app: app.name
            })
          : t('chat.botCards.composio.readyTitle', '{{bot}} can now use {{app}}', {
              bot: botName,
              app: app.name
            })
      }
      meta={
        gone
          ? t('chat.botCards.composio.goneDetail', 'Set it up again from the bot’s Tools.')
          : connection?.label
            ? t(
                'chat.botCards.composio.readyAs',
                'As {{label}}. Your app sign-ins are held by Composio.',
                { label: connection.label }
              )
            : t('chat.botCards.composio.custody', 'Your app sign-ins are held by Composio.')
      }
      fontScale={fontScale}
    >
      {/* The desktop's Browse more apps opens the bot's app catalog: the phone's is in Add a connector. */}
      {gone ? null : panel ? (
        <MobileBotCardActions>
          <MobileNativeChatNoticePill
            label={t('chat.botCards.composio.browse', 'Browse more apps')}
            onPress={() => panel.open({ settings: { kind: 'add' } })}
          />
        </MobileBotCardActions>
      ) : (
        <MobileGoogleSetupOnComputer
          text={t(
            'chat.botCards.composio.browseOnComputer',
            'Browse more apps from the bot’s Tools in Orca on your computer.'
          )}
          fontScale={fontScale}
        />
      )}
    </MobileGoogleSetupFrame>
  )
}

export function MobileComposioSetupCard({
  card,
  fallback,
  fontScale
}: {
  card: ComposioSetupCardRef
  fallback: string
  fontScale: number
}): React.JSX.Element | null {
  const styles = useThemedStyles(stylesSheet)
  const host = useMobileBotCardHost()
  const bot = useHostBotById(card.botId)
  const view = useMobileComposio(host?.client ?? null, host?.hostKey ?? null, card.botId)
  if (!host?.client || !bot) {
    return (
      <Text style={[styles.fallback, scaledType(typography.bodySize, fontScale)]}>{fallback}</Text>
    )
  }
  const scope: MobileComposioScope = {
    client: host.client,
    hostKey: host.hostKey,
    card,
    botName: bot.name,
    view,
    fontScale
  }
  switch (card.card) {
    case 'key':
      return <KeyCard scope={scope} hostLabel={host.hostLabel} />
    case 'connect':
      return <MobileComposioConnectCard scope={scope} />
    case 'ready':
      return <ReadyCard scope={scope} />
    case 'events':
      return <MobileComposioEventsCard scope={scope} />
  }
}

const stylesSheet = themedStyleSheet((colors) => ({
  fallback: { color: colors.textMuted }
}))
