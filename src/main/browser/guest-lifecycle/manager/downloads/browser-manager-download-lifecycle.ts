import { EventEmitter } from 'node:events'
import { browserDownloadDestinationReservations } from '../../../downloads/browser-download-destination'
import type {
  BrowserDownloadFinishedEvent,
  BrowserDownloadProgressEvent,
  BrowserDownloadRequestedEvent
} from '../../../../../shared/browser/guest-lifecycle/browser-guest-events'
import type { BrowserScreencastDownloadResult } from '../../../../../shared/browser/runtime/runtime-browser-contracts'
import type { ActiveDownload } from './browser-active-download'
import { BrowserManagerDownloadCreation } from './browser-manager-download-creation'

function downloadRequestedEvent(
  download: ActiveDownload,
  browserPageId: string
): BrowserDownloadRequestedEvent {
  return {
    browserPageId,
    downloadId: download.downloadId,
    origin: download.origin,
    filename: download.filename,
    totalBytes: download.totalBytes,
    mimeType: download.mimeType,
    savePath: download.savePath,
    status: 'downloading'
  }
}

export abstract class BrowserManagerDownloadLifecycle extends BrowserManagerDownloadCreation {
  // Keyed by browser page id; heard whether or not a window shows the page.
  private readonly downloadViewers = new EventEmitter().setMaxListeners(0)

  /** A page's download events, for the devices streaming a page no window here shows. */
  watchDownloads(
    browserPageId: string,
    listener: (event: BrowserScreencastDownloadResult) => void
  ): () => void {
    this.downloadViewers.on(browserPageId, listener)
    return () => this.downloadViewers.off(browserPageId, listener)
  }

  private tellDownloadViewers(browserPageId: string, event: BrowserScreencastDownloadResult): void {
    this.downloadViewers.emit(browserPageId, event)
  }

  protected bindDownloadToTab(downloadId: string, browserTabId: string): void {
    const download = this.downloadsById.get(downloadId)
    if (!download) {
      return
    }
    download.browserTabId = browserTabId
    download.rendererWebContentsId = this.rendererWebContentsIdByTabId.get(browserTabId) ?? null
    this.pageEvents.emit(browserTabId, {
      kind: 'download',
      filename: download.filename,
      origin: download.origin
    })
    this.tellDownloadViewers(browserTabId, {
      type: 'downloadRequested',
      download: downloadRequestedEvent(download, browserTabId)
    })
  }

  protected flushPendingDownloadRequests(browserTabId: string, guestWebContentsId: number): void {
    const pending = this.pendingDownloadIdsByGuestId.get(guestWebContentsId)
    if (!pending?.length) {
      return
    }
    this.pendingDownloadIdsByGuestId.delete(guestWebContentsId)
    for (const downloadId of pending) {
      this.bindDownloadToTab(downloadId, browserTabId)
      this.flushDownloadSnapshot(downloadId)
    }
  }

  protected flushDownloadSnapshot(downloadId: string): void {
    const download = this.downloadsById.get(downloadId)
    if (!download) {
      return
    }
    const rendererOwner = download.browserTabId
      ? this.rendererWebContentsIdByTabId.get(download.browserTabId)
      : undefined
    this.sendDownloadStarted(downloadId)
    if (download.receivedBytes > 0 || download.transientState) {
      this.sendDownloadProgress(download.browserTabId, {
        browserPageId: download.browserTabId ?? undefined,
        downloadId: download.downloadId,
        receivedBytes: download.receivedBytes,
        totalBytes: download.totalBytes,
        state: download.transientState
      })
    }
    if (download.terminalEvent) {
      this.sendDownloadFinished(download.browserTabId, {
        ...download.terminalEvent,
        browserPageId: download.browserTabId ?? undefined
      })
      this.downloadsById.delete(downloadId)
      this.releaseRetiredDownloadRenderer(download.browserTabId, rendererOwner)
    }
  }

  protected sendDownloadStarted(downloadId: string): void {
    const download = this.downloadsById.get(downloadId)
    if (!download?.browserTabId) {
      return
    }
    if (download.startedSent) {
      return
    }
    const renderer = this.resolveRendererForBrowserTab(download.browserTabId)
    if (!renderer) {
      return
    }
    renderer.send(
      'browser:download-requested',
      downloadRequestedEvent(download, download.browserTabId)
    )
    download.startedSent = true
  }

  protected sendDownloadProgress(
    browserTabId: string | null,
    payload: BrowserDownloadProgressEvent
  ): void {
    if (!browserTabId) {
      return
    }
    const renderer = this.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return
    }
    renderer.send('browser:download-progress', payload)
  }

  protected sendDownloadFinished(
    browserTabId: string | null,
    payload: BrowserDownloadFinishedEvent
  ): void {
    if (!browserTabId) {
      return
    }
    this.tellDownloadViewers(browserTabId, { type: 'downloadFinished', download: payload })
    const renderer = this.resolveRendererForBrowserTab(browserTabId)
    if (!renderer) {
      return
    }
    renderer.send('browser:download-finished', payload)
  }

  protected async settleClientHostedDownload(
    download: ActiveDownload,
    status: BrowserDownloadFinishedEvent['status'],
    failure: string | null
  ): Promise<void> {
    const route = download.clientRoute
    if (!route) {
      return
    }
    if (status !== 'completed') {
      download.clientRoute = null
      await route.abort().catch(() => undefined)
      this.finishDownloadInternal(download.downloadId, status, failure)
      return
    }
    try {
      // Keep the route reachable so cancellation can abort a remote commit in progress.
      const remoteDestination = await route.complete(download.filename)
      download.clientRoute = null
      download.remoteDestination = remoteDestination
      // The local staged copy has been deleted.
      download.savePath = ''
      this.finishDownloadInternal(download.downloadId, 'completed', null)
    } catch (error) {
      download.clientRoute = null
      if (download.terminalEvent) {
        // Cancellation already reported this outcome.
        return
      }
      console.error('[browser-download] Failed to save download to the remote workspace:', error)
      this.finishDownloadInternal(
        download.downloadId,
        'failed',
        'Could not save the download to the remote workspace.'
      )
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

  protected cancelDownloadInternal(
    downloadId: string,
    reason: string,
    status: 'canceled' | 'failed' = 'canceled'
  ): void {
    const download = this.downloadsById.get(downloadId)
    if (!download) {
      return
    }
    const rendererOwner = download.browserTabId
      ? this.rendererWebContentsIdByTabId.get(download.browserTabId)
      : undefined

    if (download.cleanup) {
      download.cleanup()
      download.cleanup = null
    }
    const shouldSendFinish = !download.terminalEvent

    try {
      download.item.cancel()
    } catch {
      // The item may already be finalized.
    }

    if (shouldSendFinish) {
      this.finishDownloadInternal(downloadId, status, reason || null)
      return
    }

    this.downloadsById.delete(downloadId)
    this.releaseRetiredDownloadRenderer(download.browserTabId, rendererOwner)
  }

  protected finishDownloadInternal(
    downloadId: string,
    status: BrowserDownloadFinishedEvent['status'],
    error: string | null
  ): void {
    const download = this.downloadsById.get(downloadId)
    if (!download || download.terminalEvent) {
      return
    }
    const rendererOwner = download.browserTabId
      ? this.rendererWebContentsIdByTabId.get(download.browserTabId)
      : undefined

    if (download.cleanup) {
      download.cleanup()
      download.cleanup = null
    }
    browserDownloadDestinationReservations.release(download.reservationKey)
    download.reservationKey = null
    if (download.clientRoute) {
      // Cancellation may finish before the relay; remove staged bytes too.
      void download.clientRoute.abort().catch(() => undefined)
      download.clientRoute = null
    }
    const event: BrowserDownloadFinishedEvent = {
      browserPageId: download.browserTabId ?? undefined,
      downloadId: download.downloadId,
      status,
      savePath: download.savePath || null,
      ...(download.remoteDestination ? { remoteDestination: download.remoteDestination } : {}),
      error
    }
    download.terminalEvent = event
    download.onFinished?.(event)
    if (download.browserTabId) {
      this.sendDownloadStarted(downloadId)
      this.sendDownloadFinished(download.browserTabId, event)
      this.downloadsById.delete(downloadId)
      this.releaseRetiredDownloadRenderer(download.browserTabId, rendererOwner)
    }
  }

  private releaseRetiredDownloadRenderer(
    browserTabId: string | null,
    rendererOwner: number | undefined
  ): void {
    if (
      !browserTabId ||
      this.webContentsIdByTabId.has(browserTabId) ||
      this.rendererWebContentsIdByTabId.get(browserTabId) !== rendererOwner
    ) {
      return
    }
    for (const download of this.downloadsById.values()) {
      if (download.browserTabId === browserTabId) {
        return
      }
    }
    this.rendererWebContentsIdByTabId.delete(browserTabId)
  }

  protected cancelPendingDownloadsForGuest(guestWebContentsId: number): void {
    const pending = this.pendingDownloadIdsByGuestId.get(guestWebContentsId)
    this.pendingDownloadIdsByGuestId.delete(guestWebContentsId)
    if (!pending?.length) {
      return
    }
    for (const downloadId of pending) {
      const download = this.downloadsById.get(downloadId)
      if (!download) {
        continue
      }
      if (download.terminalEvent) {
        this.downloadsById.delete(downloadId)
        continue
      }
      this.cancelDownloadInternal(downloadId, 'Browser page closed before download could be shown.')
      const afterCancel = this.downloadsById.get(downloadId)
      if (afterCancel?.terminalEvent && !afterCancel.browserTabId) {
        this.downloadsById.delete(downloadId)
      }
    }
  }

  protected getDownloadReceivedBytes(item: Electron.DownloadItem): number {
    try {
      return Math.max(0, item.getReceivedBytes())
    } catch {
      return 0
    }
  }
}
