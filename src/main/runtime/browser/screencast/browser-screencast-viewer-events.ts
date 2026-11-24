import type { BrowserScreencastResult } from '../../../../shared/browser/runtime/runtime-browser-contracts'
import { addBrowserPagePromptViewer } from '../../../browser/guest-lifecycle/prompts/browser-page-prompt-viewers'
import { addBrowserFileChooserViewer } from '../../../browser/guest-lifecycle/prompts/browser-file-chooser-viewers'
import { addBrowserPrintViewer } from '../../../browser/guest-lifecycle/prompts/browser-print-viewers'
import {
  offerBrowserDownloadCopy,
  releaseBrowserDownloadCopy
} from '../../../browser/guest-lifecycle/manager/downloads/browser-download-copy-offers'
import { browserManager } from '../../../browser/guest-lifecycle/manager/browser-manager'
import type { BrowserScreencastParams } from './browser-screencast-contracts'

type ScreencastViewer = { emit?: (event: BrowserScreencastResult) => void; pairedDeviceId?: string }

/** Starts the page events this viewer asked for beyond frames; returns what stops them. */
export function startScreencastViewerEvents(
  page: { guestWebContentsId: number; browserPageId: string },
  params: Pick<
    BrowserScreencastParams,
    'pagePrompts' | 'fileChoosers' | 'agentCursor' | 'downloads' | 'downloadCopyStreams' | 'prints'
  >,
  { emit, pairedDeviceId }: ScreencastViewer
): (() => void) | null {
  if (!emit) {
    return null
  }
  const stops: (() => void)[] = []
  // Only a paired device's answers can be checked.
  if (params.pagePrompts === 1 && pairedDeviceId) {
    stops.push(
      addBrowserPagePromptViewer(page.guestWebContentsId, {
        pairedDeviceId,
        show: (request) => emit({ type: 'pagePrompt', request }),
        close: (requestId) => emit({ type: 'pagePromptClosed', requestId })
      })
    )
  }
  // The pickers this viewer's own input opens.
  if (params.fileChoosers === 1 && pairedDeviceId) {
    stops.push(
      addBrowserFileChooserViewer(page.guestWebContentsId, {
        pairedDeviceId,
        ask: (request) => emit({ type: 'fileChooser', request })
      })
    )
  }
  if (params.agentCursor === 1) {
    stops.push(
      browserManager.watchAgentCursor(page.browserPageId, (point) =>
        emit({ type: 'agentCursor', ...point })
      )
    )
  }
  if (params.downloads === 1) {
    stops.push(
      params.downloadCopyStreams === 1 && pairedDeviceId
        ? watchDownloadsWithCopies(page.browserPageId, pairedDeviceId, emit)
        : browserManager.watchDownloads(page.browserPageId, emit)
    )
  }
  // The print() calls this viewer's own input makes.
  if (params.prints === 1 && pairedDeviceId) {
    stops.push(addBrowserPrintViewer(page.guestWebContentsId, { pairedDeviceId, print: emit }))
  }
  return () => {
    for (const stop of stops) {
      stop()
    }
  }
}

/** Each finished download this host saved carries a copy only this device can take. */
function watchDownloadsWithCopies(
  browserPageId: string,
  pairedDeviceId: string,
  emit: (event: BrowserScreencastResult) => void
): () => void {
  let stopped = false
  const stop = browserManager.watchDownloads(browserPageId, (event) => {
    // A client-hosted page's download went to its workspace, not a file this host keeps.
    if (
      event.type !== 'downloadFinished' ||
      event.download.status !== 'completed' ||
      !event.download.savePath ||
      event.download.remoteDestination
    ) {
      emit(event)
      return
    }
    void offerBrowserDownloadCopy(pairedDeviceId, event.download.savePath).then((copyId) => {
      if (stopped) {
        if (copyId) {
          releaseBrowserDownloadCopy(pairedDeviceId, { copyId })
        }
        return
      }
      emit(copyId ? { ...event, copyId } : event)
    })
  })
  return () => {
    stopped = true
    stop()
  }
}
