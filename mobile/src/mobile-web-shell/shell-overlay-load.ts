import { useLayoutEffect } from 'react'
import type { DownloadProgressFeed } from './download-progress-feed'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import type { ShellPageFrame } from './shell-page-frame'

export type ShellOverlayDownload = {
  receivedBytes: number
  totalBytes: number
  feed: DownloadProgressFeed
}

/** How far an overlay shell's page is from drawing over the screen beneath. */
export type ShellOverlayLoad =
  | { kind: 'loading'; download: ShellOverlayDownload | null }
  | { kind: 'painted' }
  /** The page cannot show here: an older desktop, a wall, a failure, or no connection. */
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

/**
 * Reports an overlay shell's load to the route that draws its loading state and its exits, which
 * outlive the shell's own state screens so one view covers every stage.
 */
export function useReportedShellOverlayLoad(
  onLoad: ((load: ShellOverlayLoad) => void) | undefined,
  state: MobileWebShellSessionState,
  pageFrame: ShellPageFrame,
  feed: DownloadProgressFeed
): void {
  const kind = overlayLoadOf(state, pageFrame)
  const receivedBytes = state.kind === 'fetching' ? state.receivedBytes : null
  const totalBytes = state.kind === 'fetching' ? state.totalBytes : 0
  // Before paint, so the caller's view swaps in the same frame the WebView is shown.
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
