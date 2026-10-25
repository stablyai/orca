import { Switch } from 'react-native'
import { colors } from '../theme/mobile-theme'

export type MobileSwitchProps = {
  value: boolean
  onValueChange: (value: boolean) => void
  accessibilityLabel: string
  disabled?: boolean
  testID?: string
}

// RN Web defaults active thumb to teal; override via activeThumbColor absent from native types.
const ON_THUMB = { activeThumbColor: colors.textPrimary }

/** The app's switch: neutral track and thumb, no platform accent. */
export function MobileSwitch(props: MobileSwitchProps) {
  return (
    <Switch
      {...props}
      {...ON_THUMB}
      trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
      thumbColor={colors.textPrimary}
    />
  )
}
