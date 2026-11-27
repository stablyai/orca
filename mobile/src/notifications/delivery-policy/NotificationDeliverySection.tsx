import { ListRow } from '../../components/list/ListGroup'
import { MobileSwitch } from '../../components/controls/MobileSwitch'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { SettingsSection } from '../../settings/settings-screen-frame'
import type { NotificationDeliveryPreferences } from './notification-delivery-preferences'

type Props = {
  value: NotificationDeliveryPreferences
  disabled?: boolean
  onChange: (value: NotificationDeliveryPreferences) => void
}

export function NotificationDeliverySection({ value, disabled, onChange }: Props) {
  const t = useMobileTranslation()
  const row = (key: keyof NotificationDeliveryPreferences, label: string, hint?: string) => (
    <ListRow
      key={key}
      title={label}
      subtitle={hint}
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
        'notifications.notificationDeliverySection.pauseFooter',
        'Alerts pause after 7 days without opening this app.'
      )}
    >
      {row(
        'onlyWhenDesktopAway',
        t(
          'notifications.notificationDeliverySection.onlyWhenAwayFromComputer',
          'Only when I’m away'
        ),
        t('notifications.notificationDeliverySection.awayHint', 'Idle for 3 minutes or locked')
      )}
      {row(
        'onlyWhenAgentNeedsInput',
        t(
          'notifications.notificationDeliverySection.onlyWhenAgentNeedsInput',
          'Only when an agent needs me'
        ),
        t('notifications.notificationDeliverySection.needsMeHint', 'Permissions and questions only')
      )}
      {row('sound', t('notifications.notificationDeliverySection.sound', 'Notification sound'))}
      {row(
        'suppressWhileViewing',
        t(
          'notifications.notificationDeliverySection.notWhileViewing',
          'Not for the workspace I’m viewing'
        )
      )}
    </SettingsSection>
  )
}
