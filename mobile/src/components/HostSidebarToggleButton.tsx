import { PanelLeftClose, PanelLeftOpen } from 'lucide-react-native'
import { Pressable, StyleSheet } from 'react-native'
import { colors, radii } from '../theme/mobile-theme'

type HostSidebarToggleButtonProps = {
  expanded: boolean
  onPress: () => void
}

export function HostSidebarToggleButton({ expanded, onPress }: HostSidebarToggleButtonProps) {
  const Icon = expanded ? PanelLeftClose : PanelLeftOpen
  const action = expanded ? 'Hide' : 'Show'

  return (
    <Pressable
      style={({ pressed }) => [
        styles.button,
        !expanded && styles.revealButton,
        pressed && styles.buttonPressed
      ]}
      onPress={onPress}
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${action} workspace sidebar`}
      accessibilityHint={`${action}s the workspace list`}
      accessibilityState={{ expanded }}
      hitSlop={8}
    >
      <Icon size={expanded ? 14 : 18} color={colors.textSecondary} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radii.button
  },
  revealButton: {
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderLeftWidth: 0,
    borderTopLeftRadius: 0,
    borderBottomLeftRadius: 0
  },
  buttonPressed: {
    backgroundColor: colors.bgRaised
  }
})
