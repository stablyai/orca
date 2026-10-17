import { MobileSettingsFrame } from './mobile-settings-menu'
import { MobileAppearanceSettings } from './mobile-appearance-settings'

export default function AppearanceSettingsScreen() {
  return (
    <MobileSettingsFrame title="Appearance">
      <MobileAppearanceSettings />
    </MobileSettingsFrame>
  )
}
