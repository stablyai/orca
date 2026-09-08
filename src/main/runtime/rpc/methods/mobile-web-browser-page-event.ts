import type { BrowserScreencastResult } from '../../../../shared/runtime-types'
import type { MobileWebBrowserEvent } from '../../../../shared/mobile-web/browser-operation-contract'
import { mobileWebPageBrowserUrl } from '../../../../shared/mobile-web/browser-url-privacy'

/** Screencast events carry raw tab URLs, host page ids and driver-supplied text. This is the only
 * projection the page sees, so anything not named here never reaches it. */
export function mobileWebBrowserPageEvent(
  value: BrowserScreencastResult
): MobileWebBrowserEvent | null {
  if (value.type === 'ready' || value.type === 'navigation') {
    const tab = value.tab
    return {
      type: value.type,
      tab: {
        url: mobileWebPageBrowserUrl(tab.url),
        title: tab.title.slice(0, 240),
        canGoBack: 'canGoBack' in tab && tab.canGoBack === true,
        canGoForward: 'canGoForward' in tab && tab.canGoForward === true
      }
    }
  }
  if (value.type === 'end' || value.type === 'dialogClosed') {
    return { type: value.type }
  }
  if (value.type === 'dialog') {
    return {
      type: 'dialog',
      dialogType: isDialogType(value.dialogType) ? value.dialogType : 'alert',
      message: value.message.slice(0, 8192)
    }
  }
  if (value.type === 'error') {
    return { type: 'error', message: 'Browser stream failed.' }
  }
  return null
}

function isDialogType(value: unknown): value is 'alert' | 'confirm' | 'prompt' | 'beforeunload' {
  return value === 'alert' || value === 'confirm' || value === 'prompt' || value === 'beforeunload'
}
