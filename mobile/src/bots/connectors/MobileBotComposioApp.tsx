// One app the bot signed in to through Composio, as a page in Connectors: the desktop's BotComposioAppRow.
import { useState } from 'react'
import { ExternalLink } from 'lucide-react-native'
import { errorMessage } from '../../../../src/shared/errors/error-message'
import { ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { ConfirmContent } from '../../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { openConnectorLink } from './connector-link'
import {
  composioConnect,
  composioDisconnect
} from '../../session/native-chat/transcript/bot-cards/mobile-composio-operations'
import { rereadMobileComposio } from '../../session/native-chat/transcript/bot-cards/mobile-composio-store'
import { SettingsSection } from '../../settings/settings-screen-frame'
import { colors } from '../../theme/mobile-theme'
import { AppLogo, type ComposioScope } from './MobileBotComposio'

/** One app the bot signed in to through Composio: who as, Sign in again, and Disconnect. */
export function MobileBotComposioApp(
  props: ComposioScope & {
    botName: string
    connection: { app: string; name: string; status: string; label: string | null; id?: string }
    showToast: (message: string, durationMs?: number) => void
    onBack: () => void
  }
) {
  const t = useMobileTranslation()
  const { connection } = props
  const [confirm, setConfirm] = useState(false)
  useBackClaim(() => {
    if (!confirm) {
      props.onBack()
    }
    setConfirm(false)
    return true
  })
  const accountId = connection.id
  if (confirm && accountId) {
    return (
      <ConfirmContent
        title={t('bots.composio.disconnectTitle', 'Disconnect {{app}}?', { app: connection.name })}
        message={t(
          'bots.composio.disconnectNote',
          '{{bot}} can no longer use {{app}}. You can connect it again any time.',
          { bot: props.botName, app: connection.name }
        )}
        confirmLabel={t('bots.composio.disconnect', 'Disconnect')}
        destructive
        onCancel={() => setConfirm(false)}
        onConfirm={() => {
          setConfirm(false)
          const client = props.client
          if (!client) {
            return
          }
          void composioDisconnect
            .request(client, { botId: props.botId, accountId }, { failWhenDisconnected: true })
            .then((reply) => composioDisconnect.interpret(reply))
            .then(
              () => {
                rereadMobileComposio(props.hostKey, props.botId)
                props.onBack()
              },
              (caught: unknown) => props.showToast(errorMessage(caught), 2400)
            )
        }}
      />
    )
  }
  return (
    <>
      <SheetHeader
        title={connection.name}
        subtitle={t('bots.composio.viaComposio', 'via Composio')}
        onBack={{ label: t('bots.connectors.back', 'Back to Connectors'), onPress: props.onBack }}
      />
      {props.banner}
      <SettingsSection first>
        <ListRow
          leading={<AppLogo slug={connection.app} size={20} />}
          title={
            connection.status !== 'active'
              ? connection.label
                ? t('bots.composio.signInAgainAs', 'Needs you to sign in again · {{label}}', {
                    label: connection.label
                  })
                : t('bots.composio.signInAgain', 'Needs you to sign in again')
              : connection.label
                ? t('bots.composio.connectedAs', 'Connected as {{label}}', {
                    label: connection.label
                  })
                : t('bots.composio.connected', 'Connected')
          }
          wrapTitle
        />
        <ListRow
          title={t('bots.composio.people', 'People')}
          subtitle={t('bots.composio.peopleNote', 'Anyone who can ask {{bot}} can use it', {
            bot: props.botName
          })}
        />
        <ListRow
          title={t('bots.composio.signInLabel', 'Sign-in')}
          value={t('bots.composio.signInHeld', 'Held by Composio')}
        />
      </SettingsSection>
      <SettingsSection>
        <ListRow
          title={t('bots.composio.signInAgainMenu', 'Sign in again')}
          accessory={<ExternalLink size={16} color={colors.textSecondary} />}
          disabled={!props.online}
          onPress={() => {
            const client = props.client
            if (!client) {
              return
            }
            // As the desktop's menu: Composio's sign-in opens again; the host waits for it.
            void composioConnect
              .request(client, { botId: props.botId, app: connection.app })
              .then((reply) => composioConnect.interpret(reply))
              .then(
                ({ url }) => {
                  rereadMobileComposio(props.hostKey, props.botId)
                  openConnectorLink(url)
                },
                (caught: unknown) => props.showToast(errorMessage(caught), 2400)
              )
          }}
        />
      </SettingsSection>
      {accountId ? (
        <SettingsSection>
          <ListRow
            title={t('bots.composio.disconnectNamed', 'Disconnect {{app}}', {
              app: connection.name
            })}
            destructive
            disabled={!props.online}
            accessibilityRole="button"
            onPress={() => setConfirm(true)}
          />
        </SettingsSection>
      ) : null}
    </>
  )
}
