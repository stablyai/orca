import { Text } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  DownloadProgressBar,
  downloadedMegabytesCaption
} from '../mobile-web-shell/presentation/DownloadProgressBar'
import type { ShellOverlayDownload } from '../mobile-web-shell/presentation/shell-overlay-load'
import { colors, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'

export function NewWorkspaceLoadProgress({
  download,
  onBackdrop = false
}: {
  download: ShellOverlayDownload
  onBackdrop?: boolean
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  return (
    <>
      <DownloadProgressBar
        feed={download.feed}
        receivedBytes={download.receivedBytes}
        totalBytes={download.totalBytes}
        accessibilityLabel={t('newWorkspace.loadingDrawer.downloading', 'Downloading')}
        color={onBackdrop ? colors.onAccent : undefined}
        trackColor={onBackdrop ? colors.textMuted : undefined}
      />
      <Text style={[styles.caption, onBackdrop && { color: colors.onAccent }]}>
        {t('newWorkspace.loadingDrawer.downloadProgress', 'Downloading… {{progress}}', {
          progress: downloadedMegabytesCaption(download.receivedBytes, download.totalBytes)
        })}
      </Text>
    </>
  )
}

const styles = themedStyleSheet(() => ({
  caption: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    fontVariant: ['tabular-nums']
  }
}))
