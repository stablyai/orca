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
  const downloadingLabel = t(
    'webShell.shellStateScreen.downloadingLatest',
    'Downloading the latest app'
  )
  const source =
    host === null
      ? ''
      : t('webShell.shellStateScreen.downloadingFrom', 'from {{host}} · ', { host: hostTitle })
  return (
    <ShellWaitingFrame
      label={downloadingLabel}
      indicator={
        <DownloadProgressBar
          feed={feed}
          receivedBytes={state.receivedBytes}
          totalBytes={state.totalBytes}
          accessibilityLabel={downloadingLabel}
          testID="mobile-web-shell-progress-bar"
        />
      }
      caption={`${source}${downloadedMegabytesCaption(state.receivedBytes, state.totalBytes, t)}`}
    />
  )
}
