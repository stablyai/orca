import type { LucideIcon } from 'lucide-react-native'
import { IconButton } from '../components/ui/IconButton'

type MobileSessionHeaderIconButtonProps = {
  active?: boolean
  disabled?: boolean
  accessibilityLabel: string
  icon: LucideIcon
  onPress: () => void
}

/** A session bar action: the shared 44 pt icon button, marked selected while its panel is docked. */
export function MobileSessionHeaderIconButton({
  active = false,
  disabled = false,
  accessibilityLabel,
  icon,
  onPress
}: MobileSessionHeaderIconButtonProps) {
  return (
    <IconButton
      icon={icon}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      disabled={disabled}
      selected={active}
      iconSize={20}
    />
  )
}
