import { useHostDisplay, type HostDisplaySource } from '../transport/use-host-display'
import type { DownloadProgressFeed } from './download-progress-feed'
import { DownloadProgressBar, downloadedMegabytesCaption } from './DownloadProgressBar'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import { ShellWaitingFrame } from './ShellWaitingFrame'

const DOWNLOADING_LABEL = 'Downloading the latest app'

/** The page bundle coming down from the host, as a bar over the bytes received. */
export function ShellDownloadProgress({
  state,
  feed,
  host
}: {
  state: Extract<MobileWebShellSessionState, { kind: 'fetching' }>
  feed: DownloadProgressFeed
  /** Null until the stored profile is read, which leaves the caption without a name. */
  host: HostDisplaySource | null
}) {
  const hostTitle = useHostDisplay(host).title
  const source = host === null ? '' : `from ${hostTitle} · `
  return (
    <ShellWaitingFrame
      label={DOWNLOADING_LABEL}
      indicator={
        <DownloadProgressBar
          feed={feed}
          receivedBytes={state.receivedBytes}
          totalBytes={state.totalBytes}
          accessibilityLabel={DOWNLOADING_LABEL}
          testID="mobile-web-shell-progress-bar"
        />
      }
      caption={`${source}${downloadedMegabytesCaption(state.receivedBytes, state.totalBytes)}`}
    />
  )
}
