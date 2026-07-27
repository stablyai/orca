import { webContents, type WebContents } from 'electron'

/**
 * Keeps background browser automation from stealing the host's keyboard focus.
 *
 * Why: `Input.dispatchMouseEvent` with `mousePressed` makes Chromium hand native
 * focus to the guest view that received the press. Unlike `Input.insertText`
 * (#7041 DOM.focus replay) and `Runtime.evaluate` (deliberately not focused),
 * the synthetic mouse path had no compensation, so an agent clicking in a
 * background tab pulled the caret out of whatever pane the user was typing in.
 *
 * DOM focus still follows the click — only the OS/app-level focus owner is
 * handed back, so subsequent automation that relies on `document.activeElement`
 * is unaffected.
 */
export function captureHostFocus(guestId: number): WebContents | null {
  const focused = webContents.getFocusedWebContents()
  if (!focused || focused.isDestroyed()) {
    return null
  }
  // Why: the guest already owning focus means the user is driving that view, so
  // restoring afterwards would be a no-op at best and a focus fight at worst.
  if (focused.id === guestId) {
    return null
  }
  return focused
}

export function restoreHostFocus(prior: WebContents | null): void {
  if (!prior || prior.isDestroyed()) {
    return
  }
  const current = webContents.getFocusedWebContents()
  // Why: only restore when the press actually moved focus; re-focusing an
  // already-focused WebContents can churn selection in some editors.
  if (current && current.id === prior.id) {
    return
  }
  prior.focus()
}
