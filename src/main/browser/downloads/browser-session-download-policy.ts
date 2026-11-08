import { browserManager } from '../guest-lifecycle/manager/browser-manager'
import { isRemoteCliDrivenGuest } from '../desktop-browser-bridge/remote-cli-driven-workspaces'
import { noticeDocPreviewDownloadBlocked } from '../document-preview/doc-preview-download-block-notice'

export const handleWillDownload = (
  event: Electron.Event,
  item: Electron.DownloadItem,
  webContents: Electron.WebContents
): void => {
  // Why first: Electron drops an item an earlier listener refused and never sends its done.
  if (event.defaultPrevented) {
    return
  }
  // Prevent SSH-driven pages from writing host-chosen files into desktop Downloads.
  if (isRemoteCliDrivenGuest(webContents.id)) {
    event.preventDefault()
    console.info('[desktop-browser-bridge] refused a download from a page an SSH host drives')
    return
  }
  browserManager.handleGuestWillDownload({ guestWebContentsId: webContents.id, item })
  // Why after the emit: a later listener can still refuse the item the manager just took.
  queueMicrotask(() => {
    if (event.defaultPrevented) {
      browserManager.forgetRefusedDownload(item)
    }
  })
}

// will-download omits the partition; attach each partition's selected policy to its session.
export const handleDeniedWillDownload = (
  event: Electron.Event,
  _item: Electron.DownloadItem,
  webContents: Electron.WebContents
): void => {
  event.preventDefault()
  noticeDocPreviewDownloadBlocked(webContents)
}

export type BrowserPartitionDownloadPolicy = 'route' | 'deny'
