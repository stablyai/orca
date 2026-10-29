import { useLayoutEffect } from 'react'
import type { DownloadProgressFeed } from './download-progress-feed'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import type { ShellPageFrame } from './shell-page-frame'

export type ShellOverlayDownload = {
  receivedBytes: number
  totalBytes: number
  feed: DownloadProgressFeed
}

export type ShellOverlayLoad =
  | { kind: 'loading'; download: ShellOverlayDownload | null }
  | { kind: 'painted' }
  | { kind: 'unavailable' }

function overlayLoadOf(
  state: MobileWebShellSessionState,
  pageFrame: ShellPageFrame
): ShellOverlayLoad['kind'] {
  switch (state.kind) {
    case 'route-unavailable':
    case 'wall':
    case 'failed':
    case 'offline':
      return 'unavailable'
    case 'checking':
    case 'fetching':
    case 'activating':
    case 'ready':
      return pageFrame === 'painted' ? 'painted' : 'loading'
  }
}

// Report to the route’s persistent loading/exit view so it can cover every shell state.
export function useReportedShellOverlayLoad(
  onLoad: ((load: ShellOverlayLoad) => void) | undefined,
  state: MobileWebShellSessionState,
  pageFrame: ShellPageFrame,
  feed: DownloadProgressFeed
): void {
  const kind = overlayLoadOf(state, pageFrame)
  const receivedBytes = state.kind === 'fetching' ? state.receivedBytes : null
  const totalBytes = state.kind === 'fetching' ? state.totalBytes : 0
  // Update before paint so overlay and WebView visibility change in the same frame.
  useLayoutEffect(() => {
    if (onLoad === undefined) {
      return
    }
    onLoad(
      kind === 'loading'
        ? {
            kind,
            download: receivedBytes === null ? null : { receivedBytes, totalBytes, feed }
          }
        : { kind }
    )
  }, [feed, kind, onLoad, receivedBytes, totalBytes])
}
