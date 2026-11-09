import type {
  BrowserDownloadFinishedEvent,
  BrowserDownloadProgressEvent
} from '../../../../../shared/browser-guest-events'
import type { BrowserClientDownloadRoute } from '../../../client-hosts/file-transfers/browser-client-download-routing'

export type BrowserDownloadDoneState = 'completed' | 'cancelled' | 'interrupted'
/** Why a download ended when its status cannot say: a shutdown cancels like a user would. */
export type BrowserDownloadFinishCause = 'shutdown'
export type BrowserDownloadFinishListener = (
  event: BrowserDownloadFinishedEvent,
  cause?: BrowserDownloadFinishCause,
  routedRemotely?: boolean
) => void

export type ActiveDownload = {
  downloadId: string
  guestWebContentsId: number
  browserTabId: string | null
  rendererWebContentsId: number | null
  origin: string
  filename: string
  totalBytes: number | null
  mimeType: string | null
  item: Electron.DownloadItem
  savePath: string
  reservationKey: string | null
  clientRoute: BrowserClientDownloadRoute | null
  /** Stays set after clientRoute is cleared, so the item reads as remote until its outcome. */
  routedRemotely: boolean
  remoteDestination: BrowserDownloadFinishedEvent['remoteDestination']
  receivedBytes: number
  transientState: BrowserDownloadProgressEvent['state']
  terminalEvent: BrowserDownloadFinishedEvent | null
  startedSent: boolean
  cleanup: (() => void) | null
  onFinished: BrowserDownloadFinishListener | null
}
