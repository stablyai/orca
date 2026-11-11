import type { LucideIcon } from 'lucide-react-native'
import { LIST_LEADING_INSET, ListRow } from '../components/list/ListGroup'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { SettingsSection } from './settings-screen-frame'

export type MobileSettingsMenuItem = {
  id: string
  label: string
  icon: LucideIcon
  onPress: () => void
  external?: boolean
  disabled?: boolean
}

export function MobileSettingsSection({
  items,
  first = false
}: {
  items: MobileSettingsMenuItem[]
  first?: boolean
}) {
  useMobileColorScheme()
  return (
    <SettingsSection first={first} separatorInset={LIST_LEADING_INSET}>
      {items.map(({ id, label, icon: Icon, onPress, external, disabled }) => (
        <ListRow
          key={id}
          title={label}
          leading={<Icon size={18} color={colors.textSecondary} />}
          navigates={!external}
          disabled={disabled}
          onPress={onPress}
        />
      ))}
    </SettingsSection>
  )
}
