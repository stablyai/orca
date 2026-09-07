import { browserDownloadDestinationReservations } from './browser-download-destination'
import type {
  BrowserDownloadFinishedEvent,
  BrowserDownloadProgressEvent,
  BrowserDownloadRequestedEvent
} from '../../shared/browser-guest-events'
import type { ActiveDownload } from './browser-manager-types'
import { BrowserManagerDownloadCreation } from './browser-manager-download-creation'

export abstract class BrowserManagerDownloadLifecycle extends BrowserManagerDownloadCreation {
  protected bindDownloadToTab(downloadId: string, browserTabId: string): void {
    const download = this.downloadsById.get(downloadId)
    if (!download) {
      return
    }
    download.browserTabId = browserTabId
    download.rendererWebContentsId = this.rendererWebContentsIdByTabId.get(browserTabId) ?? null
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
    renderer.send('browser:download-requested', {
      browserPageId: download.browserTabId,
      downloadId: download.downloadId,
      origin: download.origin,
      filename: download.filename,
      totalBytes: download.totalBytes,
      mimeType: download.mimeType,
      savePath: download.savePath,
      status: 'downloading'
    } satisfies BrowserDownloadRequestedEvent)
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
      // Why: the route stays on the record for the whole commit, which spans many round trips -- a
      // cancel arriving mid-stream has to find something to abort or the bytes land anyway.
      const remoteDestination = await route.complete(download.filename)
      download.clientRoute = null
      download.remoteDestination = remoteDestination
      // Why: the staged copy is deleted, so a client save path would name a file that no longer exists.
      download.savePath = ''
      this.finishDownloadInternal(download.downloadId, 'completed', null)
    } catch (error) {
      download.clientRoute = null
      if (download.terminalEvent) {
        // A cancel already reported the outcome; this rejection is that cancel taking effect.
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

  protected cancelDownloadInternal(downloadId: string, reason: string): void {
    const download = this.downloadsById.get(downloadId)
    if (!download) {
      return
    }

    if (download.cleanup) {
      download.cleanup()
      download.cleanup = null
    }
    const shouldSendCancel = !download.terminalEvent

    try {
      download.item.cancel()
    } catch {
      // Why: cancel() can throw on an already-finalized item; best-effort since UI state is authoritative.
    }

    if (shouldSendCancel) {
      this.finishDownloadInternal(downloadId, 'canceled', reason || null)
      return
    }

    this.downloadsById.delete(downloadId)
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

    if (download.cleanup) {
      download.cleanup()
      download.cleanup = null
    }
    browserDownloadDestinationReservations.release(download.reservationKey)
    download.reservationKey = null
    if (download.clientRoute) {
      // Why: a cancel path can reach here before the relay settled; the staged copy must not survive.
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
    if (download.browserTabId) {
      this.sendDownloadStarted(downloadId)
      this.sendDownloadFinished(download.browserTabId, event)
      this.downloadsById.delete(downloadId)
    }
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
