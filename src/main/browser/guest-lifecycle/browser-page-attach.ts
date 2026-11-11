import { randomUUID } from 'node:crypto'
import { BrowserError } from '../browser-error'
import { waitForBrowserGuestLoad } from './browser-guest-load'
import {
  claims,
  pages,
  retiredGuests,
  renewHeldThrottle,
  type Page
} from './browser-page-memory-state'
import { markInitialBrowserGuest } from './manager/registration/browser-guest-discard-protection'

type Attach = { pageId: string; page: Page; url: string; token: string; admitted: boolean }
const attachments = new Map<string, Attach>()
export const guestLoads = new WeakMap<Electron.WebContents, Promise<void>>()
let generation = 0
const MARKER = 'data:text/html,orca-browser-attach-'
let admittedAttach: Attach | null = null

export function prepareBrowserPageAttach(
  pageId: string,
  rendererId: number,
  partition: string,
  url: string
): string {
  let page = pages.get(pageId)
  if (page && (page.rendererId !== rendererId || page.partition !== partition)) {
    page.releaseThrottle?.()
    page.releaseThrottle = null
    page.guest = null
    page.restoring = null
    if (page.partition !== partition) {
      page.history = null
    }
    page.rendererId = rendererId
    page.partition = partition
  }
  if (!page) {
    page = {
      generation: ++generation,
      rendererId,
      partition,
      guest: null,
      claim: claims.get(pageId) ?? { held: false, operations: 0 },
      releaseThrottle: null,
      history: null,
      restoring: null,
      retired: new Map(),
      token: null
    }
    claims.set(pageId, page.claim)
    pages.set(pageId, page)
  }
  delete page.claim.pendingRendererId
  if (page.token) {
    attachments.delete(page.token)
  }
  const token = randomUUID()
  page.token = token
  attachments.set(token, { pageId, page, url, token, admitted: false })
  return MARKER + token
}

export function admitBrowserPageAttach(
  src: string,
  rendererId: number,
  partition: string
): string | null {
  if (!src.startsWith(MARKER)) {
    return null
  }
  const token = src.slice(MARKER.length)
  const attach = attachments.get(token)
  if (
    !attach ||
    attach.page.rendererId !== rendererId ||
    attach.page.partition !== partition ||
    pages.get(attach.pageId) !== attach.page ||
    attach.page.token !== token ||
    attach.admitted
  ) {
    throw new Error('Invalid browser page attach')
  }
  // A second will-attach cannot consume an admitted marker.
  attach.admitted = true
  admittedAttach = attach
  // Electron creates the guest synchronously after will-attach-webview returns.
  queueMicrotask(() => {
    if (admittedAttach === attach) {
      admittedAttach = null
    }
  })
  return token
}

export function isBrowserPageAttachMarker(src: string): boolean {
  return src.startsWith(MARKER)
}
/** Called before policy installation and any guest navigation. */
export function associateBrowserPageAttach(guest: Electron.WebContents): boolean {
  const attach = admittedAttach
  if (
    !attach ||
    guest.getType() !== 'webview' ||
    guest.hostWebContents?.id !== attach.page.rendererId
  ) {
    return false
  }
  admittedAttach = null
  attachments.delete(attach.token)
  if (pages.get(attach.pageId) !== attach.page || attach.page.token !== attach.token) {
    guest.close({ waitForBeforeUnload: false })
    return false
  }
  attach.page.token = null
  markInitialBrowserGuest(guest)
  attach.page.releaseThrottle?.()
  attach.page.releaseThrottle = null
  attach.page.guest = guest
  renewHeldThrottle(attach.page)
  guest.once('destroyed', () => {
    if (attach.page.retired.delete(guest.id)) {
      attach.page.invalidation?.notify()
    }
    retiredGuests.delete(guest.id)
    if (attach.page.guest === guest) {
      attach.page.releaseThrottle?.()
      attach.page.releaseThrottle = null
      attach.page.guest = null
    }
  })
  pendingLoads.set(guest, attach)
  return true
}
const pendingLoads = new WeakMap<Electron.WebContents, Attach>()

/** Route pages call this only after their existing main-owned navigation grant. */
export function startBrowserPageAttach(guest: Electron.WebContents, url?: string): boolean {
  const attach = pendingLoads.get(guest)
  if (!attach) {
    return false
  }
  pendingLoads.delete(guest)
  const page = attach.page
  const snapshot = page.history
  if (snapshot) {
    let outcome: 'pending' | 'committed' | 'failed' = 'pending'
    const dispose = (): void => {
      guest.off('did-start-navigation', started)
      guest.off('did-navigate', committed)
      guest.off('did-fail-load', failed)
      guest.off('did-finish-load', finished)
      guest.off('did-stop-loading', stopped)
      guest.off('destroyed', dispose)
    }
    const isCurrent = (): boolean => {
      if (pages.get(attach.pageId) === page && page.guest === guest && page.history === snapshot) {
        return true
      }
      dispose()
      return false
    }
    const started = (
      details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
    ): void => {
      if (isCurrent() && details.isMainFrame && !details.isSameDocument) {
        outcome = 'pending'
      }
    }
    const committed = (): void => {
      if (isCurrent() && outcome === 'pending') {
        outcome = 'committed'
      }
    }
    const failed = (
      _event: Electron.Event,
      code: number,
      _description: string,
      _url: string,
      main: boolean
    ): void => {
      if (isCurrent() && main && code !== -3) {
        outcome = 'failed'
      }
    }
    const finished = (): void => {
      if (isCurrent() && outcome === 'committed') {
        page.history = null
        dispose()
      }
    }
    const stopped = (): void => {
      if (isCurrent()) {
        outcome = 'pending'
      }
    }
    guest.on('did-start-navigation', started)
    guest.on('did-navigate', committed)
    guest.on('did-fail-load', failed)
    guest.on('did-finish-load', finished)
    guest.on('did-stop-loading', stopped)
    guest.once('destroyed', dispose)
  }
  const promise = waitForBrowserGuestLoad(guest, () =>
    snapshot
      ? guest.navigationHistory.restore({ entries: snapshot.entries, index: snapshot.index })
      : guest.loadURL(url ?? attach.url)
  ).then(() => {
    if (pages.get(attach.pageId) !== page || page.guest !== guest) {
      throw new Error('Browser page replaced')
    }
    if (snapshot && page.history === snapshot) {
      throw new BrowserError(
        'browser_navigation_failed',
        'The browser page could not be restored. Try reloading it.'
      )
    }
  })
  page.restoring = promise
  guestLoads.set(guest, promise)
  void promise
    .catch(() => {})
    .finally(() => {
      if (page.restoring === promise) {
        page.restoring = null
        page.invalidation?.notify()
      }
      if (guestLoads.get(guest) === promise) {
        guestLoads.delete(guest)
      }
    })
  return true
}

export function forgetBrowserPageAttach(page: Page): void {
  if (page.token) {
    attachments.delete(page.token)
  }
}

export function hasPendingBrowserPageAttach(guest: Electron.WebContents): boolean {
  return pendingLoads.has(guest)
}
