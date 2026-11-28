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

/**
 * A failed row retries on tap and a clash reopens its sheet; anything not mid-transfer can be let go.
 * The × sits beside the row's button, not inside it, so VoiceOver reaches both.
 */
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
  // No answer to the commit: the file may be there, so the row only asks the user to look.
  const unconfirmed = upload.status === 'unconfirmed'
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
          : unconfirmed
            ? t(
                'files.fileExplorerUpload.unconfirmed',
                "Couldn't confirm the upload. Check the folder."
              )
            : failed
              ? t('files.fileExplorerUpload.failed', '{{reason}} · Tap to retry', {
                  reason: failureText(
                    upload.error,
                    t('files.fileExplorerUpload.failedReason', 'Upload failed')
                  )
                })
              : t('files.fileExplorerUpload.waiting', 'Waiting')
  const fraction = upload.byteLength > 0 ? sent / upload.byteLength : 0

  const problem = failed || unconfirmed
  return (
    <View style={[styles.row, own.row, { paddingLeft }]}>
      <Pressable
        style={({ pressed }) => [own.main, pressed && actionable && styles.rowPressed]}
        disabled={!actionable}
        onPress={() => (failed ? retryUpload(upload.id) : setClashPromptClosed([upload.id], false))}
        accessibilityRole="button"
        accessibilityState={{ disabled: !actionable }}
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
            <Text
              style={[own.detail, problem && own.detailError]}
              numberOfLines={problem ? 2 : 1}
              // The page announces a change of state (waiting, failed) as it happens.
              accessibilityLiveRegion="polite"
            >
              {detail}
            </Text>
          </View>
        </View>
      </Pressable>
      {dismissable ? (
        <Pressable
          style={({ pressed }) => [own.dismiss, pressed && styles.rowPressed]}
          hitSlop={spacing.sm}
          onPress={() => dismissUpload(upload.id)}
          accessibilityRole="button"
          accessibilityLabel={t('files.fileExplorerUpload.dismiss', "Don't upload {{name}}", {
            name: upload.name
          })}
        >
          <X size={16} color={colors.textMuted} />
        </Pressable>
      ) : null}
    </View>
  )
}

// The download bar's colours, thinned to sit under a name.
const uploadStylesSheet = themedStyleSheet((colors) => ({
  row: { minHeight: 50 },
  // The row's own padding and gap stay on the outer row; this fills it up to the ×.
  main: {
    flex: 1,
    minWidth: 0,
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm
  },
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
