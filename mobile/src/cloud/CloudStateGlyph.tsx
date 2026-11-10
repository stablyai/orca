import { Cloud } from 'lucide-react-native'
import { View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { CloudWorkspaceStatus } from './cloud-control-plane-client'
import { CloudStatusDot } from './CloudStatusDot'

/** A centred cloud state's mark (MobileStateView iconElement): the Cloud glyph, with the workspace's
 *  state dot when there is one, so the phone's asleep and sign-in screens match the desktop's (DS-38). */
export function CloudStateGlyph({ status }: { status?: CloudWorkspaceStatus }) {
  useMobileColorScheme()
  return (
    <View
      style={styles.glyph}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      <Cloud size={24} color={colors.textMuted} strokeWidth={1.75} />
      {status ? (
        <View style={styles.ring}>
          <CloudStatusDot status={status} size={9} />
        </View>
      ) : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  glyph: { width: 24, height: 24 },
  // Centred states sit on the screen's own background, which never changes under the dot.
  ring: {
    position: 'absolute',
    right: -5,
    bottom: -4,
    padding: 2,
    borderRadius: 999,
    backgroundColor: colors.bgBase
  }
}))
