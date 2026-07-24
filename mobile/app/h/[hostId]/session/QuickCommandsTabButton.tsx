import { Pressable, View } from 'react-native'
import { SquareChevronRight } from 'lucide-react-native'

import { useTheme, useThemedStyles } from '../../../../src/theme/theme-context'
import { createMobileSessionStyles } from './mobile-session-styles'

type Props = {
  disabled: boolean
  onPress: () => void
}

export function QuickCommandsTabButton({ disabled, onPress }: Props) {
  const { colors } = useTheme()
  const styles = useThemedStyles(createMobileSessionStyles)
  return (
    <>
      <View style={styles.tabActionDivider} />
      <Pressable
        style={({ pressed }) => [
          styles.newTerminalButton,
          pressed && styles.newTerminalButtonPressed,
          disabled && styles.newTerminalButtonDisabled
        ]}
        disabled={disabled}
        onPress={onPress}
        accessibilityLabel="Quick commands"
      >
        <SquareChevronRight size={16} color={colors.textSecondary} strokeWidth={2.2} />
      </Pressable>
    </>
  )
}
