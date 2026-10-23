import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { RefreshCw } from 'lucide-react-native'
import { colors, MIN_TOUCH_TARGET } from '../theme/mobile-theme'
import { IconButton } from './ui/IconButton'

type Props = {
  onPress: () => void
  busy: boolean
  disabled?: boolean
  accessibilityLabel: string
}

/** A nav bar refresh that turns into a spinner while the reload runs, so a tap visibly lands. */
export function MobileNavRefreshButton({
  onPress,
  busy,
  disabled = false,
  accessibilityLabel
}: Props) {
  if (busy) {
    return (
      <View
        style={styles.busy}
        accessibilityRole="progressbar"
        accessibilityLabel={`${accessibilityLabel}, in progress`}
      >
        <View style={styles.circle}>
          <ActivityIndicator size="small" color={colors.textSecondary} />
        </View>
      </View>
    )
  }
  return (
    <IconButton
      icon={RefreshCw}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      disabled={disabled}
      iconSize={18}
    />
  )
}

const styles = StyleSheet.create({
  busy: {
    width: MIN_TOUCH_TARGET,
    height: MIN_TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center'
  },
  circle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.fill
  }
})
