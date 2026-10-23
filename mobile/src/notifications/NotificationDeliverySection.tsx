import { ListGroup } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import { SectionHeader } from '../components/ui/SectionHeader'
import { MobileSwitch } from '../components/MobileSwitch'
import { triggerSelection } from '../platform/haptics'
import { SettingsFooter } from '../settings/settings-screen-frame'
import type { NotificationDeliveryPreferences } from './notification-delivery-preferences'

type Props = {
  value: NotificationDeliveryPreferences
  disabled?: boolean
  onChange: (value: NotificationDeliveryPreferences) => void
}

export function NotificationDeliverySection({ value, disabled, onChange }: Props) {
  const row = (key: keyof NotificationDeliveryPreferences, label: string, hint?: string) => (
    <ListRow
      key={key}
      title={label}
      subtitle={hint}
      subtitleNumberOfLines={2}
      disabled={disabled}
      accessory={
        <MobileSwitch
          accessibilityLabel={label}
          testID={`notification-${key}`}
          value={value[key]}
          disabled={disabled}
          onValueChange={(enabled) => {
            triggerSelection()
            onChange({ ...value, [key]: enabled })
          }}
        />
      }
    />
  )
  return (
    <>
      <SectionHeader title="Delivery" />
      <ListGroup>
        {row(
          'onlyWhenDesktopAway',
          'Only when away from desktop',
          'After 3 minutes without keyboard or mouse activity, or when locked.'
        )}
        {row('sound', 'Notification sound')}
        {row(
          'suppressWhileViewing',
          'Suppress while focused',
          'Skip alerts for the workspace open on this phone.'
        )}
      </ListGroup>
      <SettingsFooter>
        Alert types follow each paired desktop’s notification settings. They pause after 7 days
        without opening this app.
      </SettingsFooter>
    </>
  )
}
