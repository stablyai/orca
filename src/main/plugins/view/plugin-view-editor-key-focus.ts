import type { WebContents } from 'electron'

/** The host page's script that gives the guest's `<webview>` DOM focus. */
export function hostWebviewFocusScript(guestContentsId: number): string {
  return `(() => {
    const webview = [...document.querySelectorAll('webview')].find((each) => {
      try { return each.getWebContentsId() === ${guestContentsId} } catch { return false }
    })
    webview?.focus()
    return document.activeElement === webview
  })()`
}

/** The guest's script that focuses what keys should reach: its focused element, else the one
 *  under the last click or drag, else the document. */
export function guestKeyTargetFocusScript(lastPoint: { x: number; y: number } | null): string {
  const point = lastPoint ? `document.elementFromPoint(${lastPoint.x}, ${lastPoint.y})` : 'null'
  return `(() => {
    const active = document.activeElement
    const target = active && active !== document.body ? active : ${point}
    target?.focus?.({ preventScroll: true })
    return document.hasFocus()
  })()`
}

/**
 * Moves keyboard focus into the guest before a key act, as a person clicking it would, so keys
 * sent partway through a sequence are not dropped. DOM focus only: `webContents.focus()` would
 * focus the hidden window on macOS and Linux.
 */
export async function focusEditorGuestForKeys(
  host: WebContents,
  guest: WebContents,
  lastPoint: { x: number; y: number } | null
): Promise<void> {
  // Why caught: a guest still attaching cannot be focused yet; the key is sent regardless.
  await host.executeJavaScript(hostWebviewFocusScript(guest.id)).catch(() => false)
  await guest.executeJavaScript(guestKeyTargetFocusScript(lastPoint)).catch(() => false)
}
