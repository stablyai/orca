// Track root-page ownership for popup download and renderer-event routing.
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

export function resolveBrowserRouteGuestPopupOpener(popupWebContentsId: number): number | null {
  return openerByPopupWebContentsId.get(popupWebContentsId) ?? null
}

export function listBrowserRouteGuestPopups(): number[] {
  return [...openerByPopupWebContentsId.keys()]
}

export function isBrowserRouteGuestPopup(webContentsId: number): boolean {
  return openerByPopupWebContentsId.has(webContentsId)
}

export function resetBrowserRouteGuestPopupOwnership(): void {
  openerByPopupWebContentsId.clear()
}
