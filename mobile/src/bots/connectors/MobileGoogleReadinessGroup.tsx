// Google's "What it can use" for one account: a row per thing the person picked, with its fix.
import {
  ArrowUpRight,
  CalendarDays,
  Folder,
  Mail,
  Users,
  type LucideIcon
} from 'lucide-react-native'
import {
  GOOGLE_CHOICE_SERVICES,
  GOOGLE_SERVICES,
  googleApiEnableUrl,
  type GoogleService
} from '../../../../src/shared/google/google-scopes'
import { LIST_LEADING_INSET, ListRow } from '../../components/list/ListGroup'
import type { Translate } from '../../i18n/mobile-i18n'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useClipboardWriter } from '../../platform/clipboard/clipboard'
import { googleChoiceLabel } from '../../session/native-chat/transcript/bot-cards/mobile-google-setup-copy'
import { MobileNativeChatNoticePill } from '../../session/native-chat/transcript/notices/MobileNativeChatNoticePill'
import { SettingsSection } from '../../settings/settings-screen-frame'
import { colors } from '../../theme/mobile-theme'
import { openGoogleConsoleLink } from './connector-link'
import type { PhoneGoogle, PhoneGoogleStatus } from './phone-google-accounts'

export type GoogleAccount = NonNullable<PhoneGoogleStatus['accounts']>[number]
type Readiness = GoogleAccount['services'][number]

const SERVICE_ICONS: Record<string, LucideIcon> = {
  gmail: Mail,
  calendar: CalendarDays,
  files: Folder,
  contacts: Users
}

/** A service this build knows; a newer host's others are left out. */
function knownService(name: string): GoogleService | undefined {
  return GOOGLE_SERVICES.find((service) => service === name)
}

/** One row per thing the person picked (Drive, Docs and Sheets together), each at its worst. */
export function readinessRows(
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

/** Things to fix on an account's services. */
export function googleProblemCount(account: GoogleAccount, t: Translate): number {
  return readinessRows(account.services, t).filter((row) => row.readiness.state !== 'ready').length
}

export function GoogleReadinessGroup(props: {
  account: GoogleAccount
  google: PhoneGoogle
  /** Says who can use it under the group; null on an account's own page. */
  botName: string | null
  online: boolean
  first: boolean
  showToast: (message: string) => void
  hostName: string
  /** Google's sign-in again, for what the person didn't allow; null where the host takes it only itself. */
  onAllowAgain: (() => void) | null
}) {
  const t = useMobileTranslation()
  const clipboard = useClipboardWriter()
  const { account, google } = props
  const clientId = google.status?.client?.clientId ?? null
  const fix = (email: string, readiness: Readiness) => {
    const service = knownService(readiness.service)
    const enableUrl = readiness.enableUrl ?? (service ? googleApiEnableUrl(service) : null)
    switch (readiness.state) {
      case 'api-disabled':
        return enableUrl
          ? {
              label: t('bots.google.fix.turnOn', 'Turn on'),
              onPress: () => openGoogleConsoleLink(enableUrl, email)
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
        return props.onAllowAgain
          ? t('bots.google.state.notAllowed', 'You didn’t allow it')
          : t('bots.google.state.allowOnHost', 'Allow again on {{host}}', { host: props.hostName })
      case 'blocked-by-admin':
        return t('bots.google.state.adminBlocked', 'Your company’s Google admin blocked it')
      default:
        return readiness.detail ?? t('bots.google.state.error', 'Couldn’t check')
    }
  }
  const rows = readinessRows(account.services, t)
  if (rows.length === 0) {
    return null
  }
  // One sign-in allows every service it lists, so one row asks for it.
  const { onAllowAgain } = props
  const allowAgain = onAllowAgain && rows.some((row) => row.readiness.state === 'needs-permission')
  return (
    <SettingsSection
      title={t('bots.google.bot.uses', 'What it can use')}
      first={props.first}
      separatorInset={LIST_LEADING_INSET}
      footer={
        props.botName === null
          ? undefined
          : t(
              'bots.google.bot.whoNote',
              'Anyone who can ask {{name}} can have it read and send your email, calendar and files.',
              { name: props.botName }
            )
      }
    >
      {rows.map((row) => {
        const action = fix(account.email, row.readiness)
        const Icon = SERVICE_ICONS[row.key] ?? Mail
        return (
          <ListRow
            key={row.key}
            leading={<Icon size={18} color={colors.textSecondary} />}
            title={row.label}
            subtitle={row.readiness.state === 'ready' ? undefined : stateLabel(row.readiness)}
            value={row.readiness.state === 'ready' ? stateLabel(row.readiness) : undefined}
            accessory={
              action ? (
                <MobileNativeChatNoticePill
                  label={action.label}
                  disabled={!props.online}
                  onPress={action.onPress}
                />
              ) : undefined
            }
          />
        )
      })}
      {allowAgain ? (
        <ListRow
          leading={<ArrowUpRight size={18} color={colors.accentBlue} />}
          accent
          title={t('bots.google.fix.allowAgain', 'Allow again')}
          accessibilityRole="link"
          disabled={!props.online}
          onPress={onAllowAgain}
        />
      ) : null}
    </SettingsSection>
  )
}
