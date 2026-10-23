import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react-native'
import { LIST_LEADING_INSET } from '../components/ui/ListGroup'
import { ListRow } from '../components/ui/ListRow'
import {
  ExternalLinkAccessory,
  SettingsRowIcon,
  SettingsScreen,
  SettingsSection
} from './settings-screen-frame'

export function MobileSettingsFrame({
  children,
  onBack
}: {
  children: ReactNode
  onBack?: () => void
}) {
  return (
    <SettingsScreen title="Settings" onBack={onBack}>
      {children}
    </SettingsScreen>
  )
}

export type MobileSettingsMenuItem = {
  label: string
  icon: LucideIcon
  onPress: () => void
  external?: boolean
  disabled?: boolean
}

/** One headed group of the Settings root: icon rows that open a page or leave the app. */
export function MobileSettingsSection({
  title,
  items,
  first = false,
  footer
}: {
  title: string
  items: MobileSettingsMenuItem[]
  first?: boolean
  footer?: ReactNode
}) {
  return (
    <>
      <SettingsSection title={title} first={first} separatorInset={LIST_LEADING_INSET}>
        {items.map(({ label, icon, onPress, external, disabled }) => (
          <ListRow
            key={label}
            title={label}
            leading={<SettingsRowIcon icon={icon} />}
            navigates={!external}
            accessory={external ? <ExternalLinkAccessory /> : undefined}
            accessibilityRole={external ? 'link' : 'button'}
            disabled={disabled}
            onPress={onPress}
          />
        ))}
      </SettingsSection>
      {footer}
    </>
  )
}
