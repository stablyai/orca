import type {
  BrowserDownloadFinishedEvent,
  BrowserDownloadProgressEvent
} from '../../../../../shared/browser/guest-lifecycle/browser-guest-events'
import type { BrowserClientDownloadRoute } from '../../../client-hosts/file-transfers/browser-client-download-routing'

export type BrowserDownloadDoneState = 'completed' | 'cancelled' | 'interrupted'

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
  remoteDestination: BrowserDownloadFinishedEvent['remoteDestination']
  receivedBytes: number
  transientState: BrowserDownloadProgressEvent['state']
  terminalEvent: BrowserDownloadFinishedEvent | null
  startedSent: boolean
  cleanup: (() => void) | null
  onFinished: ((event: BrowserDownloadFinishedEvent) => void) | null
}
