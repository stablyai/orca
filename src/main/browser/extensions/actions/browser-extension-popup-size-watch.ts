import { BROWSER_EXTENSION_POPUP_MAX } from './browser-extension-popup-geometry'

type Size = { width: number; height: number }

// Why its own world: the popup page never sees Orca's observers or the state they keep.
const POPUP_SIZE_WORLD_ID = 1_999

/**
 * Runs in the popup's isolated world and resolves with the page's size the next time it differs
 * from the last one it resolved with. Chrome sizes a popup to the document's min-content width and
 * its height at that width; a constructed stylesheet applies that width just long enough to read
 * the root box, without touching the DOM the page observes. A page without a doctype (quirks mode)
 * stretches html and body to the window, so the sheet also sizes them to their content there.
 * Mutations (which still fire in a hidden window) and resizes re-measure, debounced, so
 * late-rendering popups grow and shrink.
 */
const WATCH_SIZE_SCRIPT = `(() => {
  const MAX_WIDTH = ${BROWSER_EXTENSION_POPUP_MAX.width}
  let state = window.__orcaPopupSize
  const deliver = () => {
    if (!state.resolve || !state.pending) return
    const resolve = state.resolve
    const size = state.pending
    state.resolve = null
    state.pending = null
    state.reported = size.width + 'x' + size.height
    resolve(size)
  }
  if (!state) {
    state = window.__orcaPopupSize = { reported: '', pending: null, resolve: null, timer: 0 }
    const measureAt = (width) => {
      const sheet = new CSSStyleSheet()
      const quirks = document.compatMode === 'BackCompat'
      sheet.replaceSync('html{box-sizing:border-box!important;min-width:0!important;max-width:none!important;width:' + width + '!important}' +
        (quirks ? 'html,body{height:fit-content!important}' : ''))
      const sheets = document.adoptedStyleSheets
      sheets.push(sheet)
      try {
        return document.documentElement.getBoundingClientRect()
      } finally {
        sheets.splice(sheets.indexOf(sheet), 1)
      }
    }
    const update = () => {
      state.timer = 0
      if (!document.documentElement) return
      const fit = measureAt('min-content')
      const width = Math.ceil(fit.width)
      const rect = width > MAX_WIDTH ? measureAt(MAX_WIDTH + 'px') : fit
      const size = { width, height: Math.ceil(rect.height) }
      state.pending = size.width + 'x' + size.height === state.reported ? null : size
      deliver()
    }
    const schedule = () => {
      if (!state.timer) state.timer = setTimeout(update, 50)
    }
    new MutationObserver(schedule).observe(document, {
      subtree: true, childList: true, attributes: true, characterData: true
    })
    const resizes = new ResizeObserver(schedule)
    resizes.observe(document.documentElement)
    if (document.body) resizes.observe(document.body)
    window.addEventListener('load', schedule)
    if (document.fonts) document.fonts.ready.then(schedule)
    update()
  }
  return new Promise((resolve) => {
    state.resolve = resolve
    deliver()
  })
})()`

export function parseBrowserExtensionPopupSize(value: unknown): Size | null {
  if (typeof value !== 'object' || value === null || !('width' in value) || !('height' in value)) {
    return null
  }
  const { width, height } = value
  return typeof width === 'number' &&
    typeof height === 'number' &&
    Number.isFinite(width) &&
    Number.isFinite(height)
    ? { width, height }
    : null
}

/**
 * Hands `apply` every new size of the popup's current document until `isCurrent` turns false or
 * the document goes away. Resolves once the first size was applied (or none could be measured).
 */
export function watchBrowserExtensionPopupSize(
  contents: Electron.WebContents,
  isCurrent: () => boolean,
  apply: (size: Size) => void
): Promise<void> {
  return new Promise((firstApplied) => {
    const poll = async (): Promise<void> => {
      for (;;) {
        const measured: unknown = await contents
          .executeJavaScriptInIsolatedWorld(POPUP_SIZE_WORLD_ID, [{ code: WATCH_SIZE_SCRIPT }])
          .catch(() => null)
        const size = parseBrowserExtensionPopupSize(measured)
        if (!size || contents.isDestroyed() || !isCurrent()) {
          break
        }
        apply(size)
        firstApplied()
      }
      firstApplied()
    }
    void poll()
  })
}
