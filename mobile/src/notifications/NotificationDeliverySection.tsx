import { ListRow } from '../components/list/ListGroup'
import { MobileSwitch } from '../components/MobileSwitch'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { SettingsSection } from '../settings/settings-screen-frame'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { NotificationDeliveryPreferences } from './notification-delivery-preferences'

type Props = {
  value: NotificationDeliveryPreferences
  disabled?: boolean
  onChange: (value: NotificationDeliveryPreferences) => void
}

export function NotificationDeliverySection({ value, disabled, onChange }: Props) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const row = (key: keyof NotificationDeliveryPreferences, label: string, hint?: string) => (
    <ListRow
      key={key}
      title={label}
      subtitle={hint}
      disabled={disabled}
      accessory={
        <MobileSwitch
          accessibilityLabel={label}
          testID={`notification-${key}`}
          value={value[key]}
          disabled={disabled}
          onValueChange={(enabled) => onChange({ ...value, [key]: enabled })}
        />
      }
    />
  )
  return (
    <SettingsSection
      footer={t(
        'notifications.notificationDeliverySection.footer',
        'Alert types follow each paired desktop’s notification settings. Notifications pause after 7 days without using this app; open it and reconnect to resume.'
      )}
    >
      {row(
        'onlyWhenDesktopAway',
        t('notifications.notificationDeliverySection.onlyWhenAway', 'Only when away from desktop'),
        t(
          'notifications.notificationDeliverySection.onlyWhenAwayHint',
          'After 3 minutes without keyboard or mouse activity, or when locked.'
        )
      )}
      {row(
        'onlyWhenAgentNeedsInput',
        t(
          'notifications.notificationDeliverySection.onlyWhenAgentNeedsInput',
          'Only when an agent needs me'
        ),
        t(
          'notifications.notificationDeliverySection.onlyWhenAgentNeedsInputHint',
          'Permission requests and questions. Skips finished agents.'
        )
      )}
      {row('sound', t('notifications.notificationDeliverySection.sound', 'Notification sound'))}
      {row(
        'suppressWhileViewing',
        t(
          'notifications.notificationDeliverySection.suppressWhileFocused',
          'Suppress while focused'
        ),
        t(
          'notifications.notificationDeliverySection.suppressWhileFocusedHint',
          'Skip alerts for the workspace open on this phone.'
        )
      )}
    </SettingsSection>
  )
}
