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

/** A popup a page opened on a paired client's click; that client moves to it. */
export type ServerPagePopupPresentation = {
  worktreeId: string
  browserPageId: string
  pairedDeviceId: string
}

/** A popup that closed after being presented to a paired client; return that client to the opener. */
export type ServerPagePopupClosure = {
  worktreeId: string
  browserPageId: string
  openerBrowserPageId: string
  fallbackOpenerBrowserPageId?: string
  pairedDeviceId: string
}

/** A new tab opened from a page link (e.g. target="_blank") on a paired client's click. */
export type ServerPageLinkTabPresentation = {
  worktreeId: string
  browserPageId: string
  pairedDeviceId: string
}
