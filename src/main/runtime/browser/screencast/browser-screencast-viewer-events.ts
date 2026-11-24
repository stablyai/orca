import type { BrowserScreencastResult } from '../../../../shared/browser/runtime/runtime-browser-contracts'
import { addBrowserPagePromptViewer } from '../../../browser/guest-lifecycle/prompts/browser-page-prompt-viewers'
import { addBrowserFileChooserViewer } from '../../../browser/guest-lifecycle/prompts/browser-file-chooser-viewers'
import { addBrowserPrintViewer } from '../../../browser/guest-lifecycle/prompts/browser-print-viewers'
import { browserManager } from '../../../browser/guest-lifecycle/manager/browser-manager'
import type { BrowserScreencastParams } from './browser-screencast-contracts'

type ScreencastViewer = { emit?: (event: BrowserScreencastResult) => void; pairedDeviceId?: string }

/** Starts the page events this viewer asked for beyond frames; returns what stops them. */
export function startScreencastViewerEvents(
  page: { guestWebContentsId: number; browserPageId: string },
  params: Pick<
    BrowserScreencastParams,
    'pagePrompts' | 'fileChoosers' | 'agentCursor' | 'downloads' | 'prints'
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
    stops.push(browserManager.watchDownloads(page.browserPageId, emit))
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
