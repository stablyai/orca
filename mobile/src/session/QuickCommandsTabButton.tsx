import { View } from 'react-native'
import { SquareChevronRight } from 'lucide-react-native'

import { MobileSessionHeaderIconButton } from './MobileSessionHeaderIconButton'
import { styles } from './mobile-session-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

type Props = {
  disabled: boolean
  onPress: () => void
}

export function QuickCommandsTabButton({ disabled, onPress }: Props) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <>
      <View style={styles.tabActionDivider} />
      <MobileSessionHeaderIconButton
        disabled={disabled}
        onPress={onPress}
        accessibilityLabel={t('session.quickCommandsTabButton.quickCommands', 'Quick commands')}
        icon={SquareChevronRight}
      />
    </>
  )
}
