import { statSync } from 'node:fs'
import { BrowserError } from './cdp-bridge'
import { isAbortedNavigationError } from './agent-browser-bridge-process'
import {
  browserDownloadDestinationReservations,
  type BrowserDownloadDestination
} from './browser-download-destination'
import type { BrowserDownloadFinishedEvent } from '../../shared/browser-guest-events'

export const BROWSER_DOWNLOAD_TIMEOUT_MS = 60_000

export type BrowserDownloadReceipt = {
  path: string
  filename: string
  downloadId: string
  bytes: number
}

type Capture = {
  destination: BrowserDownloadDestination
  claimed: boolean
  cancelItem?: () => void
  finish(event?: BrowserDownloadFinishedEvent, error?: Error): void
}

export class BrowserDownloadCapture {
  private readonly capturesByPage = new Map<string, Capture>()
  private readonly navigationByPage = new Map<string, string>()

  begin(browserPageId: string, requestedPath: string) {
    if (this.capturesByPage.has(browserPageId)) {
      throw new BrowserError('browser_download_busy', 'A download is already pending on this page.')
    }
    let destination: BrowserDownloadDestination
    try {
      destination = browserDownloadDestinationReservations.reserveRequestedPath(requestedPath)
    } catch (error) {
      throw new BrowserError('browser_download_destination_unavailable', (error as Error).message)
    }
    let capture: Capture
    const result = new Promise<BrowserDownloadReceipt>((resolve, reject) => {
      const timer = setTimeout(() => {
        capture.finish(
          undefined,
          new BrowserError(
            'browser_download_timeout',
            capture.claimed
              ? 'Download did not complete within 60 seconds.'
              : 'No download started within 60 seconds.'
          )
        )
        capture.cancelItem?.()
      }, BROWSER_DOWNLOAD_TIMEOUT_MS)
      let settled = false
      capture = {
        destination,
        claimed: false,
        finish: (event, error) => {
          if (settled) {
            return
          }
          settled = true
          clearTimeout(timer)
          for (const [pageId, pending] of this.capturesByPage) {
            if (pending === capture) {
              this.capturesByPage.delete(pageId)
              this.navigationByPage.delete(pageId)
            }
          }
          browserDownloadDestinationReservations.release(destination.reservationKey)
          if (error) {
            return reject(error)
          }
          if (event?.status !== 'completed' || event.savePath !== destination.savePath) {
            return reject(
              new BrowserError(
                event?.status === 'canceled'
                  ? 'browser_download_canceled'
                  : 'browser_download_failed',
                event?.error ?? 'Download did not complete at the requested destination.'
              )
            )
          }
          try {
            const file = statSync(destination.savePath)
            if (!file.isFile()) {
              throw new Error('Download destination is not a file.')
            }
            resolve({
              path: destination.savePath,
              filename: destination.filename,
              downloadId: event.downloadId,
              bytes: file.size
            })
          } catch {
            reject(
              new BrowserError('browser_download_failed', 'Completed download file is unavailable.')
            )
          }
        }
      }
      this.capturesByPage.set(browserPageId, capture)
    })
    // Completion can race the click command's response.
    void result.catch(() => undefined)
    return {
      result,
      cancel: (error: Error) => {
        capture.finish(undefined, error)
        capture.cancelItem?.()
      }
    }
  }

  inherit(openerPageId: string, childPageId: string, url?: string): void {
    const capture = this.capturesByPage.get(openerPageId)
    if (capture && !capture.claimed) {
      this.capturesByPage.set(childPageId, capture)
      if (url) {
        this.navigationByPage.set(childPageId, url)
      }
    }
  }

  takeNavigation(browserPageId: string): string | undefined {
    const url = this.navigationByPage.get(browserPageId)
    this.navigationByPage.delete(browserPageId)
    return url
  }

  failNavigation(browserPageId: string, error: unknown): void {
    // Electron can emit ERR_FAILED before an attachment's will-download event.
    const errno = error && typeof error === 'object' && 'errno' in error ? error.errno : undefined
    if (isAbortedNavigationError(error) || errno === -2) {
      return
    }
    const capture = this.capturesByPage.get(browserPageId)
    if (capture?.claimed) {
      return
    }
    capture?.finish(
      undefined,
      new BrowserError('browser_download_failed', 'Download link navigation failed.')
    )
    capture?.cancelItem?.()
  }

  hasPending(browserPageId: string): boolean {
    const capture = this.capturesByPage.get(browserPageId)
    return Boolean(capture && !capture.claimed)
  }

  claim(browserPageId: string, cancelItem: () => void): Capture | undefined {
    const capture = this.capturesByPage.get(browserPageId)
    if (!capture || capture.claimed) {
      return undefined
    }
    capture.claimed = true
    capture.cancelItem = cancelItem
    return capture
  }

  cancelAll(): void {
    for (const capture of new Set(this.capturesByPage.values())) {
      capture.finish(
        undefined,
        new BrowserError('browser_download_canceled', 'Browser downloads were closed.')
      )
      capture.cancelItem?.()
    }
  }
}
