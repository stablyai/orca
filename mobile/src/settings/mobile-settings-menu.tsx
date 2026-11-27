import type { LucideIcon } from 'lucide-react-native'
import { ArrowUpRight } from 'lucide-react-native'
import { LIST_LEADING_INSET, ListRow } from '../components/list/ListGroup'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { SettingsSection } from './settings-screen-frame'

export type MobileSettingsMenuItem = {
  id: string
  label: string
  icon: LucideIcon
  onPress: () => void
  /** The page's current choice, e.g. Dark on Appearance. */
  value?: string
  /** Leaves the app, so the row ends in ↗ instead of a chevron. */
  external?: boolean
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
      {items.map(({ id, label, icon: Icon, onPress, value, external }) => (
        <ListRow
          key={id}
          title={label}
          value={value}
          leading={<Icon size={18} color={colors.textSecondary} />}
          navigates={!external}
          accessory={
            external ? (
              <ArrowUpRight size={15} color={colors.textMuted} strokeWidth={2.2} />
            ) : undefined
          }
          onPress={onPress}
        />
      ))}
    </SettingsSection>
  )
}
