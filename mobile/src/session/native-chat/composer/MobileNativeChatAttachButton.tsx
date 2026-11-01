import { ActivityIndicator, Pressable } from 'react-native'
import { Plus } from 'lucide-react-native'
import { colors } from '../../../theme/mobile-theme'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  composerInputStyles as inputStyles
} from '../../../components/composer-input/composer-input-styles'

export function MobileNativeChatAttachButton({
  label,
  onPress,
  isAttaching,
  disabled
}: {
  label: string
  onPress: () => void
  isAttaching?: boolean
  disabled?: boolean
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityLabel={label}
      style={({ pressed }) => [inputStyles.controlButton, pressed && inputStyles.pressed]}
      onPress={onPress}
      disabled={isAttaching || disabled}
      hitSlop={COMPOSER_CONTROL_HIT_SLOP}
    >
      {isAttaching ? (
        <ActivityIndicator size="small" color={colors.textSecondary} />
      ) : (
        <Plus size={19} color={colors.textPrimary} strokeWidth={2} />
      )}
    </Pressable>
  )
}
