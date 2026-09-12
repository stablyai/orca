import { randomUUID } from 'node:crypto'
import { browserDownloadDestinationReservations } from './browser-download-destination'
import { routeBrowserClientDownload } from './browser-client-download-routing'
import {
  safeOrigin,
  type ActiveDownload,
  type BrowserDownloadDoneState
} from './browser-manager-types'
import type { BrowserDownloadFinishedEvent } from '../../shared/browser-guest-events'
import { BrowserManagerQueries } from './browser-manager-queries'

export abstract class BrowserManagerDownloadCreation extends BrowserManagerQueries {
  handleGuestWillDownload(args: { guestWebContentsId: number; item: Electron.DownloadItem }): void {
    const { guestWebContentsId, item } = args
    const downloadId = randomUUID()
    const requestedFilename = (() => {
      try {
        return item.getFilename() || 'download'
      } catch {
        return 'download'
      }
    })()
    const totalBytes = (() => {
      try {
        const total = item.getTotalBytes()
        return total > 0 ? total : null
      } catch {
        return null
      }
    })()
    const mimeType = (() => {
      try {
        const mime = item.getMimeType()
        return mime || null
      } catch {
        return null
      }
    })()
    const origin = (() => {
      try {
        return safeOrigin(item.getURL())
      } catch {
        return 'unknown'
      }
    })()

    // Why: a client-hosted page's bytes belong on the remote workspace, so main stages them itself
    // instead of reserving a name in the desktop Downloads folder. A popup downloads to its
    // opener's page: the popup itself is a client-local transient with no logical page of its own.
    const ownerContext = this.resolvePopupOwnerContext(guestWebContentsId)
    const decision = routeBrowserClientDownload({
      guestWebContentsId: ownerContext?.rootGuestWebContentsId ?? guestWebContentsId
    })
    const clientRoute = decision.kind === 'remote' ? decision.route : null
    const destination = (() => {
      if (clientRoute) {
        return {
          filename: requestedFilename,
          savePath: clientRoute.stagingPath,
          reservationKey: null
        }
      }
      // Why: a client-hosted download with no resolvable remote destination is canceled rather than
      // written to this desktop's Downloads folder.
      if (decision.kind === 'blocked') {
        return null
      }
      try {
        return browserDownloadDestinationReservations.reserve(requestedFilename)
      } catch (error) {
        console.error('[browser-download] Failed to choose download destination:', error)
        return null
      }
    })()

    const fallbackSavePath = destination?.savePath ?? ''

    const download: ActiveDownload = {
      downloadId,
      guestWebContentsId,
      browserTabId: null,
      rendererWebContentsId: null,
      origin,
      filename: destination?.filename ?? requestedFilename,
      totalBytes,
      mimeType,
      item,
      savePath: fallbackSavePath,
      reservationKey: destination?.reservationKey ?? null,
      clientRoute,
      remoteDestination: undefined,
      receivedBytes: 0,
      transientState: null,
      terminalEvent: null,
      startedSent: false,
      cleanup: null
    }
    this.downloadsById.set(downloadId, download)

    const browserTabId = ownerContext?.browserTabId ?? null
    if (browserTabId) {
      this.bindDownloadToTab(downloadId, browserTabId)
    } else {
      const pending = this.pendingDownloadIdsByGuestId.get(guestWebContentsId) ?? []
      pending.push(downloadId)
      this.pendingDownloadIdsByGuestId.set(guestWebContentsId, pending)
    }

    if (!destination) {
      this.finishDownloadInternal(
        downloadId,
        'failed',
        decision.kind === 'blocked'
          ? 'Could not save the download to the remote workspace.'
          : 'Could not choose a Downloads file name.'
      )
      try {
        item.cancel()
      } catch {
        // Why: with no destination Chromium must not keep writing invisibly; cancel is best-effort after surfacing the failure.
      }
      return
    }

    try {
      item.setSavePath(destination.savePath)
    } catch (error) {
      console.error('[browser-download] Failed to set download destination:', error)
      this.finishDownloadInternal(downloadId, 'failed', 'Failed to set download destination.')
      try {
        item.cancel()
      } catch {
        // Why: a failed setSavePath can leave Electron partially finalized; cancel is best-effort after the UI is made terminal.
      }
      return
    }

    const updatedHandler = (_event: Electron.Event, state: 'progressing' | 'interrupted'): void => {
      download.receivedBytes = this.getDownloadReceivedBytes(download.item)
      download.transientState = state
      this.sendDownloadProgress(download.browserTabId, {
        browserPageId: download.browserTabId ?? undefined,
        downloadId: download.downloadId,
        receivedBytes: download.receivedBytes,
        totalBytes: download.totalBytes,
        state
      })
    }
    const doneHandler = (_event: Electron.Event, state: BrowserDownloadDoneState): void => {
      const status: BrowserDownloadFinishedEvent['status'] =
        state === 'completed' ? 'completed' : state === 'cancelled' ? 'canceled' : 'failed'
      const failure =
        status === 'failed'
          ? state === 'interrupted'
            ? 'Download was interrupted.'
            : 'Download failed.'
          : null
      if (download.clientRoute) {
        void this.settleClientHostedDownload(download, status, failure)
        return
      }
      this.finishDownloadInternal(download.downloadId, status, failure)
    }
    download.cleanup = (): void => {
      try {
        download.item.off('updated', updatedHandler)
        download.item.off('done', doneHandler)
      } catch {
        // Why: a completed DownloadItem may already be finalized; keep cleanup best-effort so teardown never crashes main.
      }
    }
    item.on('updated', updatedHandler)
    item.once('done', doneHandler)

    if (browserTabId) {
      this.sendDownloadStarted(downloadId)
    }
  }

  cancelDownload(args: { downloadId: string; senderWebContentsId: number }): boolean {
    const download = this.downloadsById.get(args.downloadId)
    if (!download || download.rendererWebContentsId !== args.senderWebContentsId) {
      return false
    }
    this.cancelDownloadInternal(args.downloadId, 'Canceled.')
    return true
  }
}
