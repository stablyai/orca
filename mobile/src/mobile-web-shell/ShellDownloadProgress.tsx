import { StyleSheet, View } from 'react-native'
import { colors } from '../theme/mobile-theme'
import { useHostDisplay, type HostDisplaySource } from '../transport/use-host-display'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import { ShellWaitingFrame } from './ShellWaitingFrame'

const DOWNLOADING_LABEL = 'Downloading the latest app'

function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toFixed(1)
}

/** The page bundle coming down from the host, as a bar over the bytes received. */
export function ShellDownloadProgress({
  state,
  host
}: {
  state: Extract<MobileWebShellSessionState, { kind: 'fetching' }>
  /** Null until the stored profile is read, which leaves the caption without a name. */
  host: HostDisplaySource | null
}) {
  const fraction = state.totalBytes > 0 ? Math.min(1, state.receivedBytes / state.totalBytes) : 0
  const hostTitle = useHostDisplay(host).title
  const source = host === null ? '' : `from ${hostTitle} · `
  return (
    <ShellWaitingFrame
      label={DOWNLOADING_LABEL}
      indicator={
        <View
          style={styles.track}
          accessibilityRole="progressbar"
          accessibilityLabel={DOWNLOADING_LABEL}
          accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
          testID="mobile-web-shell-progress-bar"
        >
          <View style={[styles.fill, { width: `${fraction * 100}%` }]} />
        </View>
      }
      caption={`${source}${megabytes(state.receivedBytes)} of ${megabytes(state.totalBytes)} MB`}
    />
  )
}

const styles = StyleSheet.create({
  track: {
    width: 180,
    height: 4,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: colors.bgRaised
  },
  fill: {
    height: '100%',
    backgroundColor: colors.textSecondary
  }
})
