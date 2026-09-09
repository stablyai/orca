import type { ReactNode } from 'react'
import { Shield, LifeBuoy } from 'lucide-react-native'
import { MobileSettingsFrame, MobileSettingsSection } from './mobile-settings-menu'
import {
  mobileSettingsMenuItems,
  type MobileSettingsMenuAvailability
} from './mobile-settings-menu-items'

export default function SettingsMenuScreen({
  push,
  onBack,
  openExternal,
  availability,
  children
}: {
  push: (route: string) => void
  onBack?: () => void
  openExternal: (url: string) => Promise<unknown>
  availability?: MobileSettingsMenuAvailability
  children?: ReactNode
}) {
  return (
    <MobileSettingsFrame onBack={onBack}>
      <MobileSettingsSection items={mobileSettingsMenuItems(push, availability)} />

      {children}

      <MobileSettingsSection
        spaced
        items={[
          {
            label: 'Privacy Policy',
            icon: Shield,
            external: true,
            onPress: () => void openExternal('https://www.onorca.dev/privacy')
          },
          {
            label: 'Support',
            icon: LifeBuoy,
            external: true,
            onPress: () => void openExternal('https://github.com/stablyai/orca/issues')
          }
        ]}
      />
    </MobileSettingsFrame>
  )
}
