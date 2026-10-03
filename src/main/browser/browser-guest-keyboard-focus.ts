import { randomUUID } from 'node:crypto'
import type {
  BrowserGuestKeyboardFocusRequest,
  BrowserGuestKeyboardFocusResponse
} from '../../shared/browser-guest-keyboard-focus'

export const BROWSER_GUEST_KEYBOARD_FOCUS_TIMEOUT_MS = 1_000

export type BrowserGuestKeyboardFocusOutcome = 'focused' | 'not-on-screen' | 'unanswered'

type PendingFocusRequest = {
  renderer: Electron.WebContents
  settle: (outcome: BrowserGuestKeyboardFocusOutcome) => void
}

const pendingFocusRequests = new Map<string, PendingFocusRequest>()

export function requestBrowserGuestKeyboardFocus(
  guest: Electron.WebContents
): Promise<BrowserGuestKeyboardFocusOutcome> {
  const renderer = guest.hostWebContents
  if (!renderer || renderer.isDestroyed()) {
    guest.focus()
    return Promise.resolve('unanswered')
  }
  // Why: Chromium sends CDP key events to whichever widget has focus in the embedder's tree,
  // and guest.focus() does not move that focus, so only the embedder focusing its <webview> can.
  const requestId = randomUUID()
  const request: BrowserGuestKeyboardFocusRequest = { requestId, webContentsId: guest.id }
  return new Promise((resolve) => {
    const onUnavailable = (): void => settle('unanswered')
    const timer = setTimeout(onUnavailable, BROWSER_GUEST_KEYBOARD_FOCUS_TIMEOUT_MS)
    const settle = (outcome: BrowserGuestKeyboardFocusOutcome): void => {
      if (!pendingFocusRequests.delete(requestId)) {
        return
      }
      clearTimeout(timer)
      renderer.removeListener('destroyed', onUnavailable)
      resolve(outcome)
    }
    pendingFocusRequests.set(requestId, { renderer, settle })
    renderer.once('destroyed', onUnavailable)
    try {
      renderer.send('browser:guest-keyboard-focus-requested', request)
    } catch {
      settle('unanswered')
    }
  })
}

export function respondToBrowserGuestKeyboardFocus(
  sender: Electron.WebContents,
  response: BrowserGuestKeyboardFocusResponse
): boolean {
  if (
    !response ||
    typeof response.requestId !== 'string' ||
    typeof response.focused !== 'boolean'
  ) {
    return false
  }
  const request = pendingFocusRequests.get(response.requestId)
  if (!request || request.renderer.id !== sender.id) {
    return false
  }
  request.settle(response.focused ? 'focused' : 'not-on-screen')
  return true
}
