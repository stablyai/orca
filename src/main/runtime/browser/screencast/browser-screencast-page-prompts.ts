import type { BrowserScreencastResult } from '../../../../shared/browser/runtime/runtime-browser-contracts'
import { addBrowserPagePromptViewer } from '../../../browser/guest-lifecycle/prompts/browser-page-prompt-viewers'
import { addBrowserFileChooserViewer } from '../../../browser/guest-lifecycle/prompts/browser-file-chooser-viewers'

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

/** Asks this viewer the page's prompts and hands it the pickers its own input opens, as it opted in; null when neither. */
export function askScreencastViewerPrompts(
  guestWebContentsId: number,
  params: { pagePrompts?: 1; fileChoosers?: 1 },
  stream: { emit?: (event: BrowserScreencastResult) => void; pairedDeviceId?: string }
): (() => void) | null {
  const { emit, pairedDeviceId } = stream
  const releases = [askScreencastViewerPagePrompts(guestWebContentsId, params.pagePrompts, stream)]
  // Only a paired device's answers can be checked.
  if (params.fileChoosers === 1 && emit && pairedDeviceId) {
    releases.push(
      addBrowserFileChooserViewer(guestWebContentsId, {
        pairedDeviceId,
        ask: (request) => emit({ type: 'fileChooser', request })
      })
    )
  }
  const active = releases.filter((release) => release !== null)
  return active.length === 0 ? null : () => active.forEach((release) => release())
}
