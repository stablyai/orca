import { useCallback, useEffect, useRef, useState } from 'react'
import { Text } from 'react-native'
import { Download } from 'lucide-react-native'
import { NavBarButton } from '../components/nav-bar/NavBarButton'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { filePreviewStyles as styles } from './mobile-file-preview-styles'
import { useFileSaver } from '../platform/file-saver'
import { FileSaveRefusedError } from '../platform/file-saver-contract'
import { translate } from '../i18n/mobile-i18n'
import type { MobileFilePreviewSource } from './mobile-file-preview-request'

// How long the success/error notice stays visible.
export const FILE_DOWNLOAD_NOTICE_MS = 4000

// Result line shown under the top bar after a download ends.
type Notice = { kind: 'success' | 'error'; message: string }

// The shell picks the destination and streams the file there; this only tracks busy state and the result.
// Returns the top-bar Download button (null when unavailable) and the result notice for the screen to render.
export function useMobileFileDownload(
  source: MobileFilePreviewSource | null | undefined,
  relativePath: string
) {
  const t = useMobileTranslation()
  const saver = useFileSaver()
  const [downloading, setDownloading] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const activeRef = useRef(false)
  const mountedRef = useRef(true)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const worktreeId = source?.source === 'worktree' ? source.worktreeId : undefined

  // Show a notice and replace any earlier one's dismissal timer.
  const show = useCallback((next: Notice) => {
    if (noticeTimer.current) {
      clearTimeout(noticeTimer.current)
    }
    setNotice(next)
    noticeTimer.current = setTimeout(() => setNotice(null), FILE_DOWNLOAD_NOTICE_MS)
  }, [])

  // Leaving the preview stops a download still running so no file is written for a screen the user left.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      if (noticeTimer.current) {
        clearTimeout(noticeTimer.current)
      }
      if (activeRef.current) {
        saver?.cancel()
      }
    }
  }, [saver])

  // Start one download at a time; the shell reports saved:false when the user dismisses the folder picker.
  const download = useCallback(() => {
    if (!saver || !worktreeId || !relativePath || activeRef.current) {
      return
    }
    activeRef.current = true
    setDownloading(true)
    setNotice(null)
    saver.save({ worktreeId, relativePath }).then(
      (saved) => {
        activeRef.current = false
        if (!mountedRef.current) {
          return
        }
        setDownloading(false)
        if (saved) {
          show({
            kind: 'success',
            message: translate('files.filePreviewScreen.downloadSaved', 'File saved')
          })
        }
      },
      (error: unknown) => {
        activeRef.current = false
        if (!mountedRef.current) {
          return
        }
        setDownloading(false)
        show({
          kind: 'error',
          message:
            error instanceof FileSaveRefusedError
              ? error.message
              : translate('files.filePreviewScreen.downloadFailed', 'Unable to download this file')
        })
      }
    )
  }, [saver, worktreeId, relativePath, show])

  const button =
    saver !== null && worktreeId !== undefined ? (
      <NavBarButton
        icon={Download}
        onPress={download}
        disabled={downloading}
        loading={downloading}
        accessibilityLabel={t('files.filePreviewScreen.download', 'Download file')}
      />
    ) : null
  const noticeText = notice ? (
    <Text
      style={[styles.downloadNotice, notice.kind === 'error' && styles.downloadNoticeError]}
      accessibilityLiveRegion="polite"
    >
      {notice.message}
    </Text>
  ) : null
  return { button, notice: noticeText }
}
