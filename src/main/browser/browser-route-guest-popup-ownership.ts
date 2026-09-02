/**
 * Route-guest popups are hosted in an Orca-built BaseWindow, so Electron never fires
 * `did-create-window` for them and nothing else in main can tell whose client-hosted page a popup
 * belongs to. Download routing and renderer-bound events resolve that ownership here; without it a
 * popup's bytes fall through to the desktop Downloads folder instead of the remote workspace.
 */
const openerByPopupWebContentsId = new Map<number, number>()

function isWebContentsId(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

export function registerBrowserRouteGuestPopup(input: {
  popupWebContentsId: number
  /** Root route guest of the popup chain, never an intermediate popup. */
  openerWebContentsId: number
}): void {
  if (
    !isWebContentsId(input.popupWebContentsId) ||
    !isWebContentsId(input.openerWebContentsId) ||
    input.popupWebContentsId === input.openerWebContentsId
  ) {
    return
  }
  openerByPopupWebContentsId.set(input.popupWebContentsId, input.openerWebContentsId)
}

export function releaseBrowserRouteGuestPopup(popupWebContentsId: number): void {
  openerByPopupWebContentsId.delete(popupWebContentsId)
}

/** Opener route guest of a popup, or null when the WebContents is not a live route popup. */
export function resolveBrowserRouteGuestPopupOpener(popupWebContentsId: number): number | null {
  return openerByPopupWebContentsId.get(popupWebContentsId) ?? null
}

export function isBrowserRouteGuestPopup(webContentsId: number): boolean {
  return openerByPopupWebContentsId.has(webContentsId)
}

export function resetBrowserRouteGuestPopupOwnership(): void {
  openerByPopupWebContentsId.clear()
}
