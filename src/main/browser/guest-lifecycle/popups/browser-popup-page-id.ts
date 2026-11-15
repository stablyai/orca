// WebContents ids are never reused within a run, so a popup page id stays unique while it lives.
const POPUP_PAGE_ID_PREFIX = 'popup-'

export function browserPopupPageId(webContentsId: number): string {
  return `${POPUP_PAGE_ID_PREFIX}${webContentsId}`
}

/** The webContents id a popup page id names, or null when the id is not popup-shaped. */
export function browserPopupPageWebContentsId(browserPageId: string): number | null {
  if (!browserPageId.startsWith(POPUP_PAGE_ID_PREFIX)) {
    return null
  }
  const webContentsId = Number(browserPageId.slice(POPUP_PAGE_ID_PREFIX.length))
  return Number.isInteger(webContentsId) && webContentsId > 0 ? webContentsId : null
}
