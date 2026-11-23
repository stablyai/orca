import type { WebContents } from 'electron'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl,
  redactKagiSessionToken
} from '../../../../shared/browser/navigation/browser-url'
import type { BrowserContextMenuTarget } from '../../../../shared/browser/guest-lifecycle/browser-guest-events'
import { readContextMenuSpelling } from '../../../window/editing/editable-context-menu'
import { readGuestNavigationState } from '../navigation/browser-guest-navigation-state'

// The menu event follows the dispatch that opened it; a menu this much later is someone else's.
const INJECTED_RIGHT_PRESS_MENU_WINDOW_MS = 1_000

const injectedRightPressAt = new WeakMap<WebContents, number>()

/** Records an agent's or a remote viewer's right press, whose menu is not this desktop's. */
export function noteInjectedRightPress(
  guest: WebContents,
  phase: 'mousePressed' | 'mouseReleased'
): void {
  // Chromium opens the page menu on the press, or on the release on Windows.
  if (phase === (process.platform === 'win32' ? 'mouseReleased' : 'mousePressed')) {
    injectedRightPressAt.set(guest, Date.now())
  }
}

export function isContextMenuFromInjectedPress(guest: WebContents): boolean {
  const at = injectedRightPressAt.get(guest)
  if (at === undefined || Date.now() - at > INJECTED_RIGHT_PRESS_MENU_WINDOW_MS) {
    return false
  }
  // One press opens one menu; every listener of this event reads it before the mark goes.
  setImmediate(() => {
    if (injectedRightPressAt.get(guest) === at) {
      injectedRightPressAt.delete(guest)
    }
  })
  return true
}

export function readGuestContextMenuTarget(
  guest: WebContents,
  params: Electron.ContextMenuParams
): BrowserContextMenuTarget {
  // Normalizing an empty link creates a truthy blank-page URL and a spurious Open Link item.
  const rawLinkUrl = params.linkURL || ''
  return {
    x: params.x,
    y: params.y,
    // The viewer may copy or open this URL externally; remove the Kagi token first.
    pageUrl: redactKagiSessionToken(guest.getURL()),
    linkUrl:
      rawLinkUrl.length > 0
        ? (normalizeExternalBrowserUrl(rawLinkUrl) ?? normalizeBrowserNavigationUrl(rawLinkUrl))
        : null,
    // Native selection lets Copy bypass page oncopy handlers.
    selectionText: params.selectionText ?? '',
    ...readGuestNavigationState(guest),
    editable: params.isEditable
      ? {
          canUndo: params.editFlags.canUndo,
          canRedo: params.editFlags.canRedo,
          canCut: params.editFlags.canCut,
          canCopy: params.editFlags.canCopy,
          canPaste: params.editFlags.canPaste,
          canSelectAll: params.editFlags.canSelectAll,
          spelling: readContextMenuSpelling(params)
        }
      : null,
    image:
      params.mediaType === 'image' && params.srcURL
        ? { url: params.srcURL, canCopy: params.hasImageContents }
        : null
  }
}

// Even escaped six-fold, a menu this size stays far under one remote message's 4 MiB cap.
const MAX_STREAMED_MENU_STRING_LENGTH = 256 * 1024

function fitsStreamedMenu(value: string | null | undefined): boolean {
  return (value?.length ?? 0) <= MAX_STREAMED_MENU_STRING_LENGTH
}

/** Drops what a remote message cannot carry; the viewer then shows the items that remain, as for a page with none. */
function boundStreamedContextMenu(menu: BrowserContextMenuTarget): BrowserContextMenuTarget {
  return {
    ...menu,
    pageUrl: fitsStreamedMenu(menu.pageUrl) ? menu.pageUrl : '',
    linkUrl: fitsStreamedMenu(menu.linkUrl) ? menu.linkUrl : null,
    selectionText: fitsStreamedMenu(menu.selectionText) ? menu.selectionText : '',
    image: menu.image && fitsStreamedMenu(menu.image.url) ? menu.image : null
  }
}

/** Reports menus opened by injected right presses, which a remote viewer draws. */
export function watchInjectedGuestContextMenus(
  guest: WebContents,
  onMenu: (menu: BrowserContextMenuTarget) => void
): () => void {
  const listener = (_event: Electron.Event, params: Electron.ContextMenuParams): void => {
    if (isContextMenuFromInjectedPress(guest)) {
      onMenu(boundStreamedContextMenu(readGuestContextMenuTarget(guest, params)))
    }
  }
  guest.on('context-menu', listener)
  return () => {
    if (!guest.isDestroyed()) {
      guest.off('context-menu', listener)
    }
  }
}
