import { Text, View } from 'react-native'
import { hybridShellStyles as styles } from './hybrid-shell-styles'
import type { MobileWebPackageDownloadProgress } from './mobile-web-package-downloader'

// Backgrounding suspends the connection after MobileRelayBackgroundGrace's window and the
// staged download is discarded, so the transfer restarts from zero on return.
const STAY_OPEN_HINT = 'Keep Orca open until this finishes.'

export function MobileWebPackageProgress({
  progress
}: {
  progress: MobileWebPackageDownloadProgress
}) {
  const percent =
    progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.completedBytes / progress.totalBytes) * 100))
      : 0
  const label =
    progress.phase === 'downloading'
      ? `Downloading… ${formatBytes(progress.completedBytes)} of ${formatBytes(progress.totalBytes)}`
      : 'Almost ready…'

  return (
    <View
      style={styles.packageProgress}
      testID="mobile-web-package-progress"
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: percent }}
    >
      <Text accessibilityLiveRegion="polite" style={styles.packageProgressLabel}>
        {label}
      </Text>
      <View style={styles.packageProgressTrack}>
        <View style={[styles.packageProgressFill, { width: `${percent}%` }]} />
      </View>
      {progress.phase === 'downloading' ? (
        <Text style={styles.packageProgressHint}>{STAY_OPEN_HINT}</Text>
      ) : null}
    </View>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
