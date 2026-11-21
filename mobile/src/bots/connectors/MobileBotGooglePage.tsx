// Google's page in Connectors: the desktop's BotGoogleCard with GoogleAccountSettings' readiness. Each
// service's fix runs here, except Allow again: that is Google's sign-in, which returns to the host's
// loopback and isn't on the phone's allowlist, so it says to do it on the computer.
import { BOT_CONNECTOR_NAMES } from '../../../../src/shared/bots/bot-templates'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { AppState } from 'react-native'
import { withGoogleAccount } from '../../../../src/shared/google/google-console-setup'
import {
  GOOGLE_CHOICE_SERVICES,
  GOOGLE_SERVICES,
  googleApiEnableUrl,
  type GoogleService
} from '../../../../src/shared/google/google-scopes'
import { ListRow } from '../../components/list/ListGroup'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { ConfirmContent } from '../../components/sheets/ConfirmModal'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useBackClaim } from '../../navigation/use-back-claim'
import { useClipboardWriter } from '../../platform/clipboard/clipboard'
import { openExternalLink } from '../../platform/external-links/external-link'
import { hostReadClient } from '../../query/host-read-client'
import { googleStatusRead } from '../../session/native-chat/transcript/bot-cards/mobile-bot-card-operations'
import { googleChoiceLabel } from '../../session/native-chat/transcript/bot-cards/mobile-google-setup-copy'
import { SettingsNote, SettingsSection } from '../../settings/settings-screen-frame'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { PhoneBot } from '../host-bots-operations'
import { MobileBotTextButton } from '../MobileBotTextButton'
import { googleBotSet } from './bot-connector-account-operations'

export type PhoneGoogleStatus = ReturnType<typeof googleStatusRead.interpret>
type Readiness = NonNullable<PhoneGoogleStatus['accounts']>[number]['services'][number]

/** The host's Google app and accounts; `check` asks Google again first. Null until read. */
export function usePhoneGoogleStatus(
  client: RpcClient | null,
  enabled: boolean,
  again: number
): { status: PhoneGoogleStatus | null; refresh: (check?: boolean) => Promise<void> } {
  const [status, setStatus] = useState<PhoneGoogleStatus | null>(null)
  const refresh = useCallback(
    async (check = false) => {
      if (!client) {
        return
      }
      const read = await googleStatusRead
        .request(hostReadClient(client), check ? { check: true } : {})
        .then((reply) => googleStatusRead.interpret(reply))
        // Unread, the page keeps what it showed.
        .catch(() => null)
      if (read) {
        setStatus(read)
      }
    },
    [client]
  )
  useEffect(() => {
    if (enabled) {
      void refresh()
    }
  }, [enabled, refresh, again])
  return { status, refresh }
}

/** A service this build knows; a newer host's others are left out. */
function knownService(name: string): GoogleService | undefined {
  return GOOGLE_SERVICES.find((service) => service === name)
}

/** One row per thing the person picked (Drive, Docs and Sheets together), each at its worst. */
function readinessRows(
  services: readonly Readiness[],
  t: Translate
): { key: string; label: string; readiness: Readiness }[] {
  const rows = new Map<string, { key: string; label: string; readiness: Readiness }>()
  for (const readiness of services) {
    const service = knownService(readiness.service)
    if (!service) {
      continue
    }
    const files = GOOGLE_CHOICE_SERVICES.files.includes(service)
    const key = files ? 'files' : readiness.service
    const label = files
      ? googleChoiceLabel(t, 'files')
      : readiness.service === 'contacts'
        ? t('bots.google.service.contacts', 'Find people by name')
        : readiness.service === 'gmail' || readiness.service === 'calendar'
          ? googleChoiceLabel(t, readiness.service)
          : readiness.service
    const current = rows.get(key)
    if (!current || (current.readiness.state === 'ready' && readiness.state !== 'ready')) {
      rows.set(key, { key, label, readiness })
    }
  }
  // Name lookup comes with every service; it gets a row only when it needs something.
  return [...rows.values()].filter(
    (row) => row.key !== 'contacts' || row.readiness.state !== 'ready'
  )
}

export function MobileBotGooglePage(props: {
  client: RpcClient | null
  bot: PhoneBot
  google: { status: PhoneGoogleStatus | null; refresh: (check?: boolean) => Promise<void> }
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
  const clipboard = useClipboardWriter()
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [busy, setBusy] = useState(false)
  useBackClaim(() => {
    if (!confirmRemove) {
      props.onBack()
    }
    setConfirmRemove(false)
    return true
  })
  const accounts = google.status?.accounts ?? []
  const clientId = google.status?.client?.clientId ?? null
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
            .then(
              () => props.onBack(),
              () => props.showToast(t('bots.errors.generic', 'Something went wrong. Try again.'))
            )
            .finally(() => setBusy(false))
        }}
      />
    )
  }

  const fix = (account: string, readiness: Readiness) => {
    const service = knownService(readiness.service)
    const enableUrl = readiness.enableUrl ?? (service ? googleApiEnableUrl(service) : null)
    switch (readiness.state) {
      case 'api-disabled':
        return enableUrl
          ? {
              label: t('bots.google.fix.turnOn', 'Turn on'),
              onPress: () => openExternalLink(withGoogleAccount(enableUrl, account))
            }
          : null
      case 'blocked-by-admin':
        return clientId
          ? {
              label: t('bots.google.fix.copyForAdmin', 'Copy for your admin'),
              onPress: () =>
                void clipboard
                  .writeText(
                    t(
                      'bots.google.adminRequest',
                      'Please mark this Google app as Trusted in the Admin console (Security › API controls › Manage third-party app access): {{clientId}}',
                      { clientId }
                    )
                  )
                  .then(() =>
                    props.showToast(
                      t('bots.google.copied', 'Copied. Send it to your Google admin.')
                    )
                  )
            }
          : null
      case 'error':
        return {
          label: t('bots.google.fix.checkAgain', 'Check again'),
          onPress: () => void google.refresh(true)
        }
      default:
        return null
    }
  }
  const stateLabel = (readiness: Readiness): string => {
    switch (readiness.state) {
      case 'ready':
        return t('bots.google.state.ready', 'Ready')
      case 'api-disabled':
        return t('bots.google.state.apiOff', 'Turned off in Google Cloud')
      case 'needs-permission':
        return t('bots.google.state.notAllowed', 'You didn’t allow it')
      case 'blocked-by-admin':
        return t('bots.google.state.adminBlocked', 'Your company’s Google admin blocked it')
      default:
        return readiness.detail ?? t('bots.google.state.error', 'Couldn’t check')
    }
  }
  return (
    <>
      <SheetHeader
        title={BOT_CONNECTOR_NAMES.google}
        subtitle={accounts.map((account) => account.email).join(', ') || undefined}
        onBack={{ label: t('bots.connectors.back', 'Back to Connectors'), onPress: props.onBack }}
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
      {accounts.map((account) => {
        const rows = readinessRows(account.services, t)
        const problems = rows.filter((row) => row.readiness.state !== 'ready').length
        const headline =
          account.status === 'reconnect'
            ? t('bots.google.headline.ended', 'Google access ended. Reconnect.')
            : problems === 0
              ? t('bots.google.headline.connected', 'Google is connected')
              : problems === 1
                ? t('bots.google.headline.toFixOne', 'Almost there: 1 thing to fix')
                : t('bots.google.headline.toFix', 'Almost there: {{count}} things to fix', {
                    count: problems
                  })
        const allowAgain = rows.some((row) => row.readiness.state === 'needs-permission')
        return (
          <SettingsSection
            key={account.email}
            title={
              accounts.length > 1 ? account.email : t('bots.google.bot.uses', 'What it can use')
            }
          >
            <ListRow title={headline} wrapTitle strong />
            {account.status === 'reconnect'
              ? null
              : rows.map((row) => {
                  const action = fix(account.email, row.readiness)
                  return (
                    <ListRow
                      key={row.key}
                      title={row.label}
                      subtitle={action ? stateLabel(row.readiness) : undefined}
                      value={action ? undefined : stateLabel(row.readiness)}
                      accessory={
                        action ? (
                          <MobileBotTextButton
                            label={action.label}
                            disabled={!props.online}
                            onPress={action.onPress}
                          />
                        ) : undefined
                      }
                    />
                  )
                })}
            {account.status === 'reconnect' || allowAgain ? (
              <ListRow
                title={t('bots.google.signInOnHost', 'Sign in to Google again on {{host}}', {
                  host: hostName
                })}
                wrapTitle
              />
            ) : null}
          </SettingsSection>
        )
      })}
      {accounts.length > 0 ? (
        <SettingsNote>
          {t('bots.google.moreOnHost', 'Add a service or share the setup in Orca on {{host}}.', {
            host: hostName
          })}
        </SettingsNote>
      ) : null}
      <SettingsSection title={t('bots.google.bot.who', 'Who can use it')}>
        <ListRow
          title={t(
            'bots.google.bot.whoNote',
            'Anyone who can ask {{name}} can have it read and send your email, calendar and files.',
            { name: bot.name }
          )}
          wrapTitle
        />
      </SettingsSection>
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
    </>
  )
}
