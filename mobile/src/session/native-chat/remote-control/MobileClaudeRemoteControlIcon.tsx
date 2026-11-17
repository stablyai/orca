import { View } from 'react-native'
import { RadioTower } from 'lucide-react-native'
import { MobileAgentIcon } from '../../../components/icons/MobileAgentIcon'
import { colors } from '../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'

/** Claude's logo with the desktop's broadcast badge, for a Claude chat's Remote Control. */
export function MobileClaudeRemoteControlIcon({
  size = 14,
  surface
}: {
  size?: number
  /** What the badge sits on, so its disc reads as a cut-out of that surface. */
  surface: 'chat' | 'panel'
}): React.JSX.Element {
  useMobileColorScheme()
  return (
    <View style={{ width: size, height: size }}>
      <MobileAgentIcon agentId="claude" size={size} />
      <View style={[styles.badge, surface === 'chat' ? styles.onChat : styles.onPanel]}>
        <RadioTower size={8} color={colors.textPrimary} strokeWidth={2} />
      </View>
    </View>
  )
}

const BADGE_SIZE = 11

const styles = themedStyleSheet(() => ({
  badge: {
    position: 'absolute',
    right: -5,
    bottom: -4,
    width: BADGE_SIZE,
    height: BADGE_SIZE,
    borderRadius: BADGE_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center'
  },
  onChat: {
    backgroundColor: colors.bgBase
  },
  onPanel: {
    backgroundColor: colors.bgPanel
  }
}))
