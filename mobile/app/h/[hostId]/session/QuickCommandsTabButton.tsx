import { Pressable, View } from 'react-native'
import { SquareChevronRight } from 'lucide-react-native'

import { colors } from '../../../../src/theme/mobile-theme'
import { styles } from './mobile-session-styles'

type Props = {
  disabled: boolean
  onPress: () => void
}

export function QuickCommandsTabButton({ disabled, onPress }: Props) {
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
