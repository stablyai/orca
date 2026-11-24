import type { BrowserClientAutomationMethod } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import { isPasteChord } from '../../cdp/input/browser-paste-chord'

export type BrowserClientPageDesktopDataRefusal = { code: string; message: string }

const SHOWN_ON_DESKTOP = 'is not available for this page because it is shown on the paired desktop'
const USE_TYPE_OR_FILL = 'Use orca type or orca fill instead.'

/** The page's server drives it but never reads the desktop's cookies or clipboard; both the server and the desktop refuse. */
export function browserClientPageDesktopDataRefusal(
  method: BrowserClientAutomationMethod,
  params: Record<string, unknown>
): BrowserClientPageDesktopDataRefusal | null {
  if (
    method === 'browser.cookie.get' ||
    method === 'browser.cookie.set' ||
    method === 'browser.cookie.delete'
  ) {
    return {
      code: 'browser_client_cookies_unsupported',
      message: `cookie ${method.slice('browser.cookie.'.length)} ${SHOWN_ON_DESKTOP}: agents on this host can use the page's sign-ins, but can't read or change its cookies.`
    }
  }
  if (method === 'browser.clipboardRead') {
    return {
      code: 'browser_client_clipboard_unsupported',
      message: `clipboard read ${SHOWN_ON_DESKTOP}: this host can't read the desktop clipboard.`
    }
  }
  if (method === 'browser.clipboardWrite') {
    return {
      code: 'browser_client_clipboard_unsupported',
      message: `clipboard write ${SHOWN_ON_DESKTOP}: this host can't use the desktop clipboard. ${USE_TYPE_OR_FILL}`
    }
  }
  if (method === 'browser.keypress' && isPasteChord(params.key)) {
    return {
      code: 'browser_client_clipboard_unsupported',
      message: `A paste shortcut ${SHOWN_ON_DESKTOP}: this host can't paste from the desktop clipboard. ${USE_TYPE_OR_FILL}`
    }
  }
  return null
}
