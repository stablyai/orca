import type { BrowserScreencastResult } from '../../../../shared/browser/runtime/runtime-browser-contracts'
import { addBrowserPagePromptViewer } from '../../../browser/guest-lifecycle/prompts/browser-page-prompt-viewers'

/** Asks this viewer the page's prompts; null when it didn't ask for them or isn't a paired device, whose answer can be checked. */
export function askScreencastViewerPagePrompts(
  guestWebContentsId: number,
  pagePrompts: 1 | undefined,
  stream: { emit?: (event: BrowserScreencastResult) => void; pairedDeviceId?: string }
): (() => void) | null {
  const { emit, pairedDeviceId } = stream
  if (pagePrompts !== 1 || !emit || !pairedDeviceId) {
    return null
  }
  return addBrowserPagePromptViewer(guestWebContentsId, {
    pairedDeviceId,
    show: (request) => emit({ type: 'pagePrompt', request }),
    close: (requestId) => emit({ type: 'pagePromptClosed', requestId })
  })
}
