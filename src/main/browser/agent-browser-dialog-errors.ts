import { BrowserError } from './cdp-bridge'
import { getBrowserJavaScriptDialog } from './browser-javascript-dialogs'
import type { BrowserJavaScriptDialog } from '../../shared/browser-javascript-dialog'

const DIALOG_MESSAGE_QUOTE_MAX_CHARS = 500

// Page-controlled text, so quote it and keep it short.
export function quoteDialogMessage({ message }: BrowserJavaScriptDialog): string {
  return JSON.stringify(
    message.length > DIALOG_MESSAGE_QUOTE_MAX_CHARS
      ? `${message.slice(0, DIALOG_MESSAGE_QUOTE_MAX_CHARS)}…`
      : message
  )
}

export function dialogAnswerHint(dialog: BrowserJavaScriptDialog, browserPageId: string): string {
  const page = `--page ${browserPageId}`
  return dialog.type === 'prompt'
    ? `Answer it with \`orca dialog accept ${page} --text <answer>\` or \`orca dialog dismiss ${page}\``
    : `Answer it with \`orca dialog accept ${page}\` or \`orca dialog dismiss ${page}\``
}

// Commands block until the page's dialog closes, so agents must answer it first.
export function assertNoJavaScriptDialog(
  webContentsId: number,
  browserPageId: string,
  admit: (id: number) => void
): void {
  const open = getBrowserJavaScriptDialog(webContentsId)
  if (open) {
    // A host must not read a dialog on a page it may not drive.
    admit(webContentsId)
    throw new BrowserError(
      'browser_dialog_open',
      `A JavaScript ${open.type} is open on this page: ${quoteDialogMessage(open)}. ${dialogAnswerHint(open, browserPageId)}, then retry.`
    )
  }
}
