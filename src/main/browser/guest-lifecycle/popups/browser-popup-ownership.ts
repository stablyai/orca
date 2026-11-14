export type PopupOwnerContext = {
  browserTabId: string
  rootGuestWebContentsId: number
}

/** A live popup window an agent can drive, owned by the tab whose page opened its chain. */
export type BrowserPopupPage = {
  browserPageId: string
  webContentsId: number
  openerBrowserPageId: string
}
