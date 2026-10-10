/**
 * Whether a new-window request from a page should open an Orca tab rather than a popup window.
 *
 * Chromium's disposition already carries Chrome's answer: new-tab links, Cmd/Ctrl/middle clicks, and
 * `window.open` without window features (`noopener` and `noreferrer` are not features) arrive as a
 * tab, while size/position features and Shift-click arrive as `new-window`. Orca answers a tab by
 * denying, which hands the page `null`, so a named open — whose flow may use that handle, as OAuth
 * does — stays a child window.
 */
export function isNewBrowserTabPopupIntent(details: {
  frameName: string
  disposition: string
}): boolean {
  return (
    details.frameName === '' &&
    (details.disposition === 'foreground-tab' || details.disposition === 'background-tab')
  )
}
