import type { RemoteDesktopPageState } from '../../../shared/hosted-sandbox/cloud-remote-desktop'

/** Orca Cloud remote desktop pages in the browser pane. */
export type RemoteDesktopBrowserApi = {
  /** A browser page became (or stopped being) a remote desktop, or gained or lost the keyboard. */
  onRemoteDesktopState: (callback: (args: RemoteDesktopPageState) => void) => () => void
  /** The release chord was pressed in a remote desktop: give the keyboard back to Orca. */
  onRemoteDesktopRelease: (callback: (args: { browserPageId: string }) => void) => () => void
}
