/**
 * Whether a new-window request from a page should open an Orca tab rather than a popup window.
 *
 * Chromium's disposition already carries Chrome's own answer: links with a new-tab target,
 * Cmd/Ctrl/middle clicks, and `window.open` without window features arrive as a tab, while
 * size/position features and Shift-click arrive as `new-window`. Orca answers a tab by denying,
 * which hands the page `null`, so a named open that keeps its opener — a handle an OAuth flow may
 * use — stays a child window.
 */
export function isNewBrowserTabPopupIntent(details: {
  frameName: string
  disposition: string
  features: string
}): boolean {
  return (
    (details.disposition === 'foreground-tab' || details.disposition === 'background-tab') &&
    (details.frameName === '' || seversOpener(details.features))
  )
}

/** HTML's `noopener`/`noreferrer` boolean parse: the page gets `null` back, as Orca's tab gives. */
function seversOpener(features: string): boolean {
  return features
    .toLowerCase()
    .replace(/\s*=\s*/g, '=')
    .split(/[\s,]+/)
    .some((token) => {
      const [name, value = ''] = token.split('=', 2)
      if (name !== 'noopener' && name !== 'noreferrer') {
        return false
      }
      const parsed = value.trim()
      if (parsed === '' || parsed === 'yes' || parsed === 'true') {
        return true
      }
      const number = Number.parseInt(parsed, 10)
      return Number.isFinite(number) && number !== 0
    })
}
