import { useHostDisplay, type HostDisplaySource } from '../../host-descriptors/use-host-display'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { DownloadProgressFeed } from './download-progress-feed'
import { DownloadProgressBar, downloadedMegabytesCaption } from './DownloadProgressBar'
import type { MobileWebShellSessionState } from '../session/mobile-web-shell-session-contract'
import { ShellWaitingFrame } from './ShellWaitingFrame'

export function ShellDownloadProgress({
  state,
  feed,
  host
}: {
  state: Extract<MobileWebShellSessionState, { kind: 'fetching' }>
  feed: DownloadProgressFeed
  host: HostDisplaySource | null
}) {
  const t = useMobileTranslation()
  const hostTitle = useHostDisplay(host).title
  const label = t('webShell.shellStateScreen.downloadingLatestApp', 'Downloading the latest app')
  const progress = downloadedMegabytesCaption(state.receivedBytes, state.totalBytes, t)
  const caption =
    host === null
      ? progress
      : t('webShell.shellStateScreen.downloadProgressFromHost', 'from {{host}} · {{progress}}', {
          host: hostTitle,
          progress
        })
  return (
    <ShellWaitingFrame
      label={label}
      indicator={
        <DownloadProgressBar
          feed={feed}
          receivedBytes={state.receivedBytes}
          totalBytes={state.totalBytes}
          accessibilityLabel={label}
          testID="mobile-web-shell-progress-bar"
        />
      }
      caption={caption}
    />
  )
}
