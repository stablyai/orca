import { Pressable, type StyleProp, type ViewStyle } from 'react-native'
import { ChevronsDownUp, ChevronsUpDown } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'

type CollapseAllGroupsButtonProps = {
  allCollapsed: boolean
  disabled?: boolean
  onPress: () => void
  style?: StyleProp<ViewStyle>
}

export function CollapseAllGroupsButton({
  allCollapsed,
  disabled = false,
  onPress,
  style
}: CollapseAllGroupsButtonProps) {
  const Icon = allCollapsed ? ChevronsUpDown : ChevronsDownUp
  return (
    <Pressable
      style={style}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={allCollapsed ? 'Expand all groups' : 'Collapse all groups'}
    >
      <Icon size={16} color={disabled ? colors.textMuted : colors.textSecondary} />
    </Pressable>
  )
}
