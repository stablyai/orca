import { ListRow } from '../components/list/ListGroup'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { KnownAppUpdate } from '../storage/app-update-preferences'
import { SettingsSection } from './settings-screen-frame'

export type AppUpdateCheckRowStatus = 'idle' | 'checking' | 'up-to-date' | 'failed'

function checkRowValue(
  t: Translate,
  status: AppUpdateCheckRowStatus,
  lastCheckedAt: number | null,
  now: number
) {
  if (status === 'checking') {
    return t('settings.appUpdateSettingsRows.checking', 'Checking…')
  }
  if (status === 'up-to-date') {
    return t('settings.appUpdateSettingsRows.upToDate', 'Up to date')
  }
  if (status === 'failed') {
    return t('settings.appUpdateSettingsRows.checkFailed', "Couldn't check")
  }
  if (lastCheckedAt === null) {
    return t('settings.appUpdateSettingsRows.neverChecked', 'Never')
  }
  const delta = now - lastCheckedAt
  if (delta < 60_000) {
    return t('settings.appUpdateSettingsRows.lastCheckedJustNow', 'Last checked just now')
  }
  const minutes = Math.max(0, Math.floor(delta / 60_000))
  if (minutes < 60) {
    const count = minutes
    return count === 1
      ? t('settings.appUpdateSettingsRows.lastCheckedMinutes_one', 'Last checked {{count}}m ago', {
          count
        })
      : t(
          'settings.appUpdateSettingsRows.lastCheckedMinutes_other',
          'Last checked {{count}}m ago',
          {
            count
          }
        )
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const count = hours
    return count === 1
      ? t('settings.appUpdateSettingsRows.lastCheckedHours_one', 'Last checked {{count}}h ago', {
          count
        })
      : t('settings.appUpdateSettingsRows.lastCheckedHours_other', 'Last checked {{count}}h ago', {
          count
        })
  }
  const count = Math.floor(hours / 24)
  return count === 1
    ? t('settings.appUpdateSettingsRows.lastCheckedDays_one', 'Last checked {{count}}d ago', {
        count
      })
    : t('settings.appUpdateSettingsRows.lastCheckedDays_other', 'Last checked {{count}}d ago', {
        count
      })
}

export function AppUpdateSettingsRows(props: {
  available: KnownAppUpdate | null
  lastCheckedAt: number | null
  now: number
  checkStatus: AppUpdateCheckRowStatus
  onUpdate: (url: string) => void
  /** Omitted when the install has no update channel to ask; hides the check row. */
  onCheck?: () => void
}) {
  const t = useMobileTranslation()
  const checkValue = checkRowValue(t, props.checkStatus, props.lastCheckedAt, props.now)
  const { available, onUpdate } = props
  if (!available && !props.onCheck) {
    return null
  }
  return (
    <SettingsSection>
      {available ? (
        <ListRow
          key="update"
          title={t('settings.appUpdateSettingsRows.updateToVersion', 'Update to Orca {{version}}', {
            version: available.version
          })}
          navigates
          onPress={() => onUpdate(available.url)}
        />
      ) : null}
      {props.onCheck ? (
        <ListRow
          key="check"
          title={t('settings.appUpdateSettingsRows.checkUpdates', 'Check for updates')}
          value={checkValue}
          accessibilityLabel={t(
            'settings.appUpdateSettingsRows.checkUpdatesStatus',
            'Check for updates, {{status}}',
            {
              status: checkValue
            }
          )}
          busy={props.checkStatus === 'checking'}
          onPress={props.onCheck}
        />
      ) : null}
    </SettingsSection>
  )
}
