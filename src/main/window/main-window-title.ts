import { finalizeWindowTitle } from '../../shared/window-title-format'

const STATIC_APP_TITLE = 'Orca'
const TRAILING_APP_LABEL = /( [—|-] )Orca$/

/**
 * The renderer's `<title>` resets the native title to a bare "Orca" on load; map that app label back to the
 * window's base title so a dev instance keeps its identity. Other titles pass through sanitized and clamped.
 */
export function resolveMainWindowTitle(pageTitle: string, baseTitle: string): string {
  const title = finalizeWindowTitle(pageTitle)
  if (baseTitle === STATIC_APP_TITLE) {
    return title || STATIC_APP_TITLE
  }
  if (!title || title === STATIC_APP_TITLE) {
    return baseTitle
  }
  return finalizeWindowTitle(
    title.replace(TRAILING_APP_LABEL, (_match, separator: string) => `${separator}${baseTitle}`)
  )
}
