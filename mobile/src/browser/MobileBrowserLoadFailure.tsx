import { StyleSheet, Text, View } from 'react-native'
import type { BrowserLoadError } from '../../../src/shared/browser-workspace-types'
import {
  describeBrowserLoadFailure,
  formatBrowserLoadFailureText,
  isBrowserNetworkLoadFailure
} from '../../../src/shared/browser-load-failure'
import { colors, spacing, typography } from '../theme/mobile-theme'

/** The desktop failure page's words over the streamed frame, which shows only a blank page. */
export function MobileBrowserLoadFailure({ loadError }: { loadError: BrowserLoadError }) {
  if (!isBrowserNetworkLoadFailure(loadError)) {
    return null
  }
  // Why no route: the phone can't see the SSH host's state, so SOCKS failures read as "can't reach".
  const failure = describeBrowserLoadFailure(loadError, null)
  const text = formatBrowserLoadFailureText(loadError, failure)
  return (
    <View pointerEvents="none" style={styles.page}>
      <Text style={styles.title}>{text.title}</Text>
      <Text style={styles.description}>{text.description}</Text>
      {failure.errorName ? <Text style={styles.code}>{failure.errorName}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  page: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    padding: spacing.xl,
    backgroundColor: colors.bgBase
  },
  title: {
    color: colors.textPrimary,
    fontSize: typography.titleSize,
    fontWeight: '600',
    textAlign: 'center'
  },
  description: {
    color: colors.textSecondary,
    fontSize: typography.bodySize,
    lineHeight: 20,
    textAlign: 'center'
  },
  code: {
    color: colors.textMuted,
    fontFamily: typography.monoFamily,
    fontSize: typography.metaSize,
    textAlign: 'center'
  }
})
