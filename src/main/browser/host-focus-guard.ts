import { webContents, type WebContents } from 'electron'

// Why: a synthetic mousePressed hands native focus to the guest that received it,
// pulling the caret out of the pane the user was typing in (#8139). DOM focus still
// follows the click — only the OS-level focus owner is handed back.
export function captureHostFocus(guestId: number): WebContents | null {
  const focused = webContents.getFocusedWebContents()
  if (!focused || focused.isDestroyed()) {
    return null
  }
  // Why: the guest already owning focus means the user is driving that view.
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
  // Why: re-focusing an already-focused WebContents can churn selection.
  if (current && current.id === prior.id) {
    return
  }
  prior.focus()
}
