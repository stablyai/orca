/**
 * Whether a `window.open()` asks for a new tab rather than a popup window.
 *
 * Orca answers a tab by denying, which hands the page `null`, so named and featured opens — whose
 * flow may use that handle — stay popups.
 */
export function isNewBrowserTabPopupIntent(details: {
  frameName: string
  disposition: string
  features: string
}): boolean {
  return (
    details.frameName === '' &&
    details.features.trim() === '' &&
    (details.disposition === 'foreground-tab' || details.disposition === 'background-tab')
  )
}
