import { Pressable, Text, View } from 'react-native'
import { File, RotateCw, X } from 'lucide-react-native'
import { useMobileTranslation, useMobileUiLocale } from '../../i18n/use-mobile-translation'
import { intlLocaleFor } from '../../i18n/ui-intl-locale'
import { downloadedMegabytesCaption } from '../../mobile-web-shell/presentation/DownloadProgressBar'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { useMobileColors } from '../../theme/use-mobile-color-scheme'
import { fileExplorerStylesSheet } from './mobile-file-explorer-styles'
import {
  dismissUpload,
  retryUpload,
  setClashPromptClosed
} from './mobile-file-explorer-upload-queue'
import type { UploadNode } from './mobile-file-explorer-upload-rows'
import { useUploadProgress } from './mobile-file-explorer-upload-progress'

// The host's own refusals read as sentences; its codes (staged_save_limit) don't.
function failureText(error: string | undefined, fallback: string): string {
  return error && !/^[a-z_]+$/.test(error) ? error : fallback
}

/** A failed row retries on tap and a clash reopens its sheet; anything not mid-transfer can be let go. */
export function MobileFileExplorerUploadRow({
  item,
  paddingLeft
}: {
  item: UploadNode
  paddingLeft: number
}) {
  const styles = useThemedStyles(fileExplorerStylesSheet)
  const own = useThemedStyles(uploadStylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const locale = intlLocaleFor(useMobileUiLocale())
  const { upload } = item
  const sent = useUploadProgress(upload.id)
  const failed = upload.status === 'failed'
  const actionable = failed || upload.status === 'clash'
  // Anything not mid-transfer can be let go; an upload in flight finishes or fails first.
  const dismissable = upload.status !== 'uploading'
  const detail =
    upload.status === 'uploading'
      ? downloadedMegabytesCaption(sent, upload.byteLength, t, locale)
      : upload.status === 'offline'
        ? t('files.fileExplorerUpload.waitingForConnection', 'Waiting for connection')
        : upload.status === 'clash'
          ? t('files.fileExplorerUpload.nameTaken', 'Name taken · Tap to choose')
          : failed
            ? t('files.fileExplorerUpload.failed', '{{reason}} · Tap to retry', {
                reason: failureText(
                  upload.error,
                  t('files.fileExplorerUpload.failedReason', 'Upload failed')
                )
              })
            : t('files.fileExplorerUpload.waiting', 'Waiting')
  const fraction = upload.byteLength > 0 ? sent / upload.byteLength : 0

  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        own.row,
        { paddingLeft },
        pressed && actionable && styles.rowPressed
      ]}
      disabled={!actionable}
      onPress={() => (failed ? retryUpload(upload.id) : setClashPromptClosed([upload.id], false))}
      accessibilityLabel={`${upload.name}, ${detail}`}
    >
      <View style={styles.chevronSpacer} />
      <View style={styles.iconSlot}>
        {failed ? (
          <RotateCw size={18} color={colors.textSecondary} />
        ) : (
          <File size={18} color={colors.textSecondary} />
        )}
      </View>
      <View style={styles.rowTextBlock}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {upload.name}
        </Text>
        <View style={own.detailLine}>
          {upload.status === 'uploading' ? (
            <View
              style={own.track}
              accessibilityRole="progressbar"
              accessibilityValue={{ min: 0, max: upload.byteLength, now: sent }}
            >
              <View style={[own.fill, { width: `${Math.round(fraction * 100)}%` }]} />
            </View>
          ) : null}
          {/* A reason can be long; two lines keep "Tap to retry" in view. */}
          <Text style={[own.detail, failed && own.detailError]} numberOfLines={failed ? 2 : 1}>
            {detail}
          </Text>
        </View>
      </View>
      {dismissable ? (
        <Pressable
          style={({ pressed }) => [own.dismiss, pressed && styles.rowPressed]}
          hitSlop={spacing.sm}
          onPress={() => dismissUpload(upload.id)}
          accessibilityLabel={t('files.fileExplorerUpload.dismiss', "Don't upload {{name}}", {
            name: upload.name
          })}
        >
          <X size={16} color={colors.textMuted} />
        </Pressable>
      ) : null}
    </Pressable>
  )
}

// The download bar's colours, thinned to sit under a name.
const uploadStylesSheet = themedStyleSheet((colors) => ({
  row: { minHeight: 50 },
  detailLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: 3
  },
  track: {
    flex: 1,
    height: 3,
    borderRadius: 1.5,
    overflow: 'hidden',
    backgroundColor: colors.bgRaised
  },
  fill: {
    height: 3,
    backgroundColor: colors.textSecondary
  },
  detail: {
    flexShrink: 0,
    maxWidth: '100%',
    color: colors.textSecondary,
    fontSize: 13
  },
  detailError: { color: colors.statusRed, flexShrink: 1 },
  dismiss: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center'
  }
}))
