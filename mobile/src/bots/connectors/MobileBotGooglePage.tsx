// Google's page in Connectors: the desktop's BotGoogleCard with GoogleAccountSettings' readiness, default,
// Share setup and Disconnect, each account on its own page. Each fix runs here, except Allow again: that is
// Google's sign-in, which returns to the host's loopback and isn't on the phone's allowlist.
import { BOT_CONNECTOR_NAMES } from '../../../../src/shared/bots/bot-templates'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'
import { Ellipsis, Share } from 'lucide-react-native'
import { ListRow } from '../../components/list/ListGroup'
import { NavBarButton } from '../../components/nav-bar/NavBarButton'
import { PullDownMenu } from '../../components/nav-bar/PullDownMenu'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { ConfirmContent } from '../../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { PhoneBot } from '../host-bots-operations'
import { googleBotSet } from './bot-connector-account-operations'
import {
  GoogleReadinessGroup,
  googleProblemCount,
  type GoogleAccount
} from './MobileGoogleReadinessGroup'
import {
  GoogleDisconnectConfirm,
  useGoogleAccountCalls,
  type PhoneGoogle
} from './phone-google-accounts'

export function MobileBotGooglePage(props: {
  client: RpcClient | null
  bot: PhoneBot
  google: PhoneGoogle
  hostName: string
  online: boolean
  banner: ReactNode
  showToast: (message: string, durationMs?: number) => void
  onBack: () => void
  /** No account signed in: Connect Google, as Add a connector starts it. */
  onConnect: () => void
}) {
  const t = useMobileTranslation()
  const { bot, google, hostName } = props
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [disconnecting, setDisconnecting] = useState<{ email: string; revoke: boolean } | null>(
    null
  )
  const [openAccount, setOpenAccount] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuAnchor = useRef(null)
  const [busy, setBusy] = useState(false)
  const accounts = google.status?.accounts ?? []
  // Gone once it's disconnected, which shows the main page again.
  const opened = accounts.find((account) => account.email === openAccount)
  useBackClaim(() => {
    if (confirmRemove || disconnecting) {
      setConfirmRemove(false)
      setDisconnecting(null)
    } else if (opened) {
      setOpenAccount(null)
    } else {
      props.onBack()
    }
    return true
  })
  // Absent from a host too old to keep a default, where the accounts show as before.
  const defaultAccount = google.status?.defaultAccount
  const failed = () => props.showToast(t('bots.errors.generic', 'Something went wrong. Try again.'))
  const { makeDefault, shareSetup } = useGoogleAccountCalls(props.client, google, (message) =>
    message ? props.showToast(message) : failed()
  )
  // Turn on opens Google Cloud in the browser; back here, Google is asked again rather than the last check.
  const turningOn = accounts.some((account) =>
    account.services.some((entry) => entry.state === 'api-disabled')
  )
  const { refresh } = google
  useEffect(() => {
    if (!turningOn) {
      return
    }
    const back = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refresh(true)
      }
    })
    return () => back.remove()
  }, [turningOn, refresh])

  if (disconnecting) {
    return (
      <GoogleDisconnectConfirm
        client={props.client}
        google={google}
        {...disconnecting}
        onClose={() => setDisconnecting(null)}
        failed={failed}
      />
    )
  }
  if (confirmRemove) {
    return (
      <ConfirmContent
        title={t('bots.google.bot.removeTitle', 'Remove Google from {{name}}?', { name: bot.name })}
        message={t(
          'bots.google.bot.removeNoteOnHost',
          '{{name}} can no longer use your Gmail, Calendar and Drive. Google stays connected on {{host}}.',
          { name: bot.name, host: hostName }
        )}
        confirmLabel={t('bots.google.bot.removeConfirm', 'Remove')}
        destructive
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => {
          setConfirmRemove(false)
          const client = props.client
          if (!client) {
            return
          }
          setBusy(true)
          void googleBotSet
            .request(client, { botId: bot.id, on: false }, { failWhenDisconnected: true })
            .then((reply) => googleBotSet.interpret(reply))
            .then(() => props.onBack(), failed)
            .finally(() => setBusy(false))
        }}
      />
    )
  }

  const several = accounts.length > 1
  // The account the bot uses: the host's default, or the only one; its readiness is the page's.
  const shown = accounts.find((account) => account.email === defaultAccount) ?? accounts[0]
  const problemCount = (account: GoogleAccount) => googleProblemCount(account, t)
  const servicesGroup = (account: GoogleAccount, first: boolean) =>
    account.status === 'reconnect' ? null : (
      <GoogleReadinessGroup
        account={account}
        google={google}
        botName={first ? null : bot.name}
        hostName={hostName}
        online={props.online}
        first={first}
        showToast={props.showToast}
      />
    )
  if (opened) {
    const canSetDefault = several && defaultAccount !== undefined && opened.email !== defaultAccount
    return (
      <>
        <SheetHeader
          title={t('bots.connect.account', 'Account')}
          subtitle={opened.email}
          onBack={{
            label: t('bots.connectors.backShort', 'Back'),
            onPress: () => setOpenAccount(null)
          }}
        />
        {props.banner}
        {opened === shown ? null : servicesGroup(opened, true)}
        {canSetDefault ? (
          <SettingsSection first={opened === shown}>
            <ListRow
              title={t('bots.google.setDefault', 'Set as default')}
              disabled={!props.online}
              accessibilityRole="button"
              onPress={() => {
                makeDefault(opened.email)
                setOpenAccount(null)
              }}
            />
          </SettingsSection>
        ) : null}
        <SettingsSection first={opened === shown && !canSetDefault}>
          {[false, true].map((revoke) => (
            <ListRow
              key={String(revoke)}
              title={
                revoke
                  ? t('bots.google.disconnect.revoke', 'Remove and revoke at Google')
                  : t('bots.google.disconnect.removeFromHost', 'Remove from {{host}}', {
                      host: hostName
                    })
              }
              destructive
              disabled={!props.online}
              accessibilityRole="button"
              onPress={() => setDisconnecting({ email: opened.email, revoke })}
            />
          ))}
        </SettingsSection>
      </>
    )
  }

  const shownProblems = shown ? problemCount(shown) : 0
  const status = !shown
    ? null
    : shown.status === 'reconnect'
      ? t('bots.google.headline.endedOnHost', 'Google access ended. Sign in again on {{host}}.', {
          host: hostName
        })
      : shownProblems === 0
        ? t('bots.google.headline.connected', 'Google is connected')
        : shownProblems === 1
          ? t('bots.google.headline.toFixOne', 'Almost there: 1 thing to fix')
          : t('bots.google.headline.toFix', 'Almost there: {{count}} things to fix', {
              count: shownProblems
            })
  const accountLine = (account: GoogleAccount): string | undefined => {
    if (account === shown) {
      return undefined
    }
    if (account.status === 'reconnect') {
      return t('bots.google.row.signedOut', 'Signed out by Google')
    }
    const count = problemCount(account)
    return count === 0
      ? undefined
      : count === 1
        ? t('bots.google.headline.toFixOne', 'Almost there: 1 thing to fix')
        : t('bots.google.headline.toFix', 'Almost there: {{count}} things to fix', { count })
  }
  const menu = google.status?.client
    ? [
        {
          label: t('bots.google.shareButton', 'Share setup'),
          icon: Share,
          disabled: !props.online,
          onPress: shareSetup
        }
      ]
    : []
  return (
    <>
      <SheetHeader
        title={BOT_CONNECTOR_NAMES.google}
        subtitle={shown?.email}
        onBack={{ label: t('bots.connectors.back', 'Back to Connectors'), onPress: props.onBack }}
        trailingButtons={
          menu.length > 0 ? (
            <NavBarButton
              ref={menuAnchor}
              icon={Ellipsis}
              accessibilityLabel={t('bots.connector.actions', '{{name}} actions', {
                name: BOT_CONNECTOR_NAMES.google
              })}
              onPress={() => setMenuOpen(true)}
            />
          ) : undefined
        }
      />
      {props.banner}
      {google.status && accounts.length === 0 ? (
        <>
          <SettingsNote>
            {t('bots.google.bot.signedOutOnHost', 'Not connected on {{host}}', { host: hostName })}
          </SettingsNote>
          <SettingsSection>
            <ListRow
              title={t('bots.google.connect', 'Connect Google')}
              navigates
              disabled={!props.online}
              onPress={props.onConnect}
            />
          </SettingsSection>
        </>
      ) : null}
      {status ? <SettingsNote>{status}</SettingsNote> : null}
      {shown ? servicesGroup(shown, false) : null}
      {accounts.length > 0 ? (
        <SettingsSection
          title={
            several ? t('bots.google.accounts', 'Accounts') : t('bots.connect.account', 'Account')
          }
        >
          {accounts.map((account) => (
            <ListRow
              key={account.email}
              title={account.email}
              subtitle={accountLine(account)}
              value={
                several && account.email === defaultAccount
                  ? t('bots.google.defaultBadge', 'Default')
                  : undefined
              }
              navigates
              onPress={() => setOpenAccount(account.email)}
            />
          ))}
        </SettingsSection>
      ) : null}
      <SettingsSection>
        <ListRow
          title={t('bots.google.bot.removeFrom', 'Remove Google from {{name}}…', {
            name: bot.name
          })}
          destructive
          disabled={!props.online || busy}
          accessibilityRole="button"
          onPress={() => setConfirmRemove(true)}
        />
      </SettingsSection>
      <PullDownMenu
        visible={menuOpen}
        anchorRef={menuAnchor}
        onClose={() => setMenuOpen(false)}
        groups={[menu]}
      />
    </>
  )
}
