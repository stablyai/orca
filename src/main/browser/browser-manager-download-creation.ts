import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { browserDownloadDestinationReservations } from './browser-download-destination'
import { routeBrowserClientDownload } from './browser-client-download-routing'
import {
  safeOrigin,
  type ActiveDownload,
  type BrowserDownloadDoneState
} from './browser-manager-types'
import type { BrowserDownloadFinishedEvent } from '../../shared/browser-guest-events'
import { BrowserManagerQueries } from './browser-manager-queries'

export type BrowserDownloadClaim = {
  started: Promise<boolean>
  finished: Promise<BrowserDownloadFinishedEvent>
  release: () => void
}

type PendingDownloadClaim = {
  savePath: string
  start: (started: boolean) => void
  finish: (event: BrowserDownloadFinishedEvent) => void
}

export abstract class BrowserManagerDownloadCreation extends BrowserManagerQueries {
  private unownedDownloadOwnerResolver: ((webContentsId: number) => string | null) | null = null
  private readonly requestedFilenames = new WeakMap<Electron.DownloadItem, string>()
  private readonly requestedSavePaths = new WeakMap<Electron.DownloadItem, string>()
  private readonly extensionDownloads = new WeakSet<Electron.DownloadItem>()
  private readonly downloadClaimsByGuestId = new Map<number, PendingDownloadClaim>()

  /**
   * Extension pages and workers are never registered as tabs, so their downloads would wait
   * forever for a registration; the resolver names the page that owns them instead.
   */
  setUnownedDownloadOwnerResolver(resolver: (webContentsId: number) => string | null): void {
    this.unownedDownloadOwnerResolver = resolver
  }

  /** chrome.downloads items are the extension's, so an agent `download` claim never takes them. */
  markExtensionDownload(item: Electron.DownloadItem): void {
    this.extensionDownloads.add(item)
  }

  /** chrome.downloads `filename`: names the item before its destination is reserved. */
  requestDownloadFilename(item: Electron.DownloadItem, filename: string): void {
    this.requestedFilenames.set(item, filename)
  }

  /** chrome.downloads `saveAs`: the path the user chose in the save dialog, used as is. */
  requestDownloadSavePath(item: Electron.DownloadItem, savePath: string): void {
    this.requestedSavePaths.set(item, savePath)
  }

  /** Agent `download`: saves the next download this page (or its popups) starts to `savePath`. */
  claimNextDownload(guestWebContentsId: number, savePath: string): BrowserDownloadClaim {
    const started = Promise.withResolvers<boolean>()
    const finished = Promise.withResolvers<BrowserDownloadFinishedEvent>()
    const claim: PendingDownloadClaim = {
      savePath,
      start: started.resolve,
      finish: finished.resolve
    }
    this.downloadClaimsByGuestId.set(guestWebContentsId, claim)
    return {
      started: started.promise,
      finished: finished.promise,
      release: () => {
        if (this.downloadClaimsByGuestId.get(guestWebContentsId) === claim) {
          this.downloadClaimsByGuestId.delete(guestWebContentsId)
        }
      }
    }
  }

  handleGuestWillDownload(args: { guestWebContentsId: number; item: Electron.DownloadItem }): void {
    const { guestWebContentsId, item } = args
    const downloadId = randomUUID()
    const requestedFilename = (() => {
      try {
        return this.requestedFilenames.get(item) || item.getFilename() || 'download'
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

    // Stage client-hosted downloads for the remote workspace; popups use their opener.
    const ownerContext = this.resolvePopupOwnerContext(guestWebContentsId)
    const adoptedTabId = ownerContext
      ? null
      : (this.unownedDownloadOwnerResolver?.(guestWebContentsId) ?? null)
    const ownerGuestWebContentsId =
      ownerContext?.rootGuestWebContentsId ??
      (adoptedTabId ? this.getGuestWebContentsId(adoptedTabId) : null) ??
      guestWebContentsId
    const decision = routeBrowserClientDownload({ guestWebContentsId: ownerGuestWebContentsId })
    const clientRoute = decision.kind === 'remote' ? decision.route : null
    // Extension pages and chrome.downloads start their own downloads, never the agent's click.
    const isExtensionDownload = adoptedTabId !== null || this.extensionDownloads.has(item)
    const claim =
      decision.kind === 'local' && !isExtensionDownload
        ? this.downloadClaimsByGuestId.get(ownerGuestWebContentsId)
        : null
    if (claim) {
      this.downloadClaimsByGuestId.delete(ownerGuestWebContentsId)
    }
    const destination = (() => {
      if (clientRoute) {
        return {
          filename: requestedFilename,
          savePath: clientRoute.stagingPath,
          reservationKey: null
        }
      }
      // Never fall back to local Downloads for an unresolved remote destination.
      if (decision.kind === 'blocked') {
        return null
      }
      const chosenPath = claim?.savePath ?? this.requestedSavePaths.get(item)
      if (chosenPath) {
        return { filename: path.basename(chosenPath), savePath: chosenPath, reservationKey: null }
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
      cleanup: null,
      onFinished: claim?.finish ?? null
    }
    this.downloadsById.set(downloadId, download)
    claim?.start(true)

    const browserTabId = ownerContext?.browserTabId ?? adoptedTabId
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
        // Cancellation can fail after the item is finalized.
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
        // setSavePath failure can leave the item finalized.
      }
      return
    }

    const updatedHandler = (_event: Electron.Event, state: 'progressing' | 'interrupted'): void => {
      download.receivedBytes = this.getDownloadReceivedBytes(download.item)
      if (state === 'interrupted' && this.isAwaitingManualResume(download.item)) {
        // Orca offers no manual resume; defer cancellation to avoid nested native observer updates.
        setImmediate(() => {
          if (
            this.downloadsById.get(downloadId) === download &&
            !download.terminalEvent &&
            this.isAwaitingManualResume(download.item)
          ) {
            this.cancelDownloadInternal(downloadId, 'Download was interrupted.', 'failed')
          }
        })
        return
      }
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
        // The completed item may already be finalized.
      }
    }
    item.on('updated', updatedHandler)
    item.once('done', doneHandler)

    if (browserTabId) {
      this.sendDownloadStarted(downloadId)
    }
  }

  private isAwaitingManualResume(item: Electron.DownloadItem): boolean {
    try {
      return item.getState() === 'interrupted' && item.canResume()
    } catch {
      return false
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
