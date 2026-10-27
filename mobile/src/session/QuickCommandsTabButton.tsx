import { View } from 'react-native'
import { SquareChevronRight } from 'lucide-react-native'

import { MobileSessionHeaderIconButton } from './MobileSessionHeaderIconButton'
import { styles } from './mobile-session-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

type Props = {
  disabled: boolean
  onPress: () => void
}

export function QuickCommandsTabButton({ disabled, onPress }: Props) {
  useMobileColorScheme()
  return (
    <>
      <View style={styles.tabActionDivider} />
      <MobileSessionHeaderIconButton
        disabled={disabled}
        onPress={onPress}
        accessibilityLabel="Quick commands"
        icon={SquareChevronRight}
      />
    </>
  )
}
