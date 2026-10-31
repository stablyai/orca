import { Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import { formatMobileWebShellDevFacts, isDevelopmentBuild } from './mobile-web-shell-dev-facts'

export function ShellDevFacts({
  state,
  droppedBinaryFrames
}: {
  state: Extract<MobileWebShellSessionState, { kind: 'ready' }>
  droppedBinaryFrames: number
}) {
  useMobileColorScheme()
  if (!isDevelopmentBuild()) {
    return null
  }
  return (
    <View style={styles.devFacts} pointerEvents="none">
      <Text style={styles.devFactsText} testID="mobile-web-shell-dev-facts">
        {formatMobileWebShellDevFacts({
          buildId: state.buildId,
          totalBytes: state.totalBytes,
          elapsedMs: state.elapsedMs,
          droppedBinaryFrames
        })}
      </Text>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  devFacts: {
    position: 'absolute',
    left: spacing.sm,
    bottom: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.pill,
    backgroundColor: colors.bgPanel
  },
  devFactsText: {
    fontSize: typography.metaSize,
    color: colors.textMuted
  }
}))
