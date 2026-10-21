import { Switch } from 'react-native'
import { colors } from '../theme/mobile-theme'

export type MobileSwitchProps = {
  value: boolean
  onValueChange: (value: boolean) => void
  accessibilityLabel: string
  disabled?: boolean
  testID?: string
}

// react-native-web paints an "on" thumb with its own teal unless given activeThumbColor, a prop
// React Native's types do not declare.
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
