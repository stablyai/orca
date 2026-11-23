import { BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES } from '../../../../../shared/browser/client-hosting/browser-client-file-channel-protocol'
import { hasClaimedBrowserDownloadRoute } from '../../../client-hosts/file-transfers/browser-client-download-routing'
import type { ActiveDownload } from './browser-active-download'
import { BrowserManagerDownloadLifecycle } from './browser-manager-download-lifecycle'

/** Downloads whose file another host saves: an SSH host agent's claim, and the size cap for every remote route. */
export abstract class BrowserManagerRemoteDownloads extends BrowserManagerDownloadLifecycle {
  /** An SSH host's agent claimed this tab's next download, whose file goes back to that host.
   *  Extension downloads never take that claim, so they stay refused. */
  awaitsHostRelayedDownload(guestWebContentsId: number, item: Electron.DownloadItem): boolean {
    if (this.extensionDownloads.has(item)) {
      return false
    }
    const rootGuestWebContentsId =
      this.resolvePopupOwnerContext(guestWebContentsId)?.rootGuestWebContentsId ??
      guestWebContentsId
    const savePath = this.downloadClaimsByGuestId.get(rootGuestWebContentsId)?.savePath
    return typeof savePath === 'string' && hasClaimedBrowserDownloadRoute(savePath)
  }

  /** Another host takes no more than the transfer cap; stop staging bytes it would refuse. */
  protected stopOversizedRemoteDownload(download: ActiveDownload): boolean {
    if (
      !download.clientRoute ||
      download.receivedBytes <= BROWSER_CLIENT_FILE_CHANNEL_TRANSFER_MAX_BYTES
    ) {
      return false
    }
    // Deferred like the other cancels made from a native progress update.
    setImmediate(() =>
      this.cancelDownloadInternal(download.downloadId, 'The file is larger than 64 MB.', 'failed')
    )
    return true
  }
}
