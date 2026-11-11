import { randomUUID } from 'node:crypto'
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
    attach.page.retired.delete(guest.id)
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
  const complete = (): void => {
    if (pages.get(attach.pageId) === page && page.guest === guest && page.history === snapshot) {
      page.history = null
    }
  }
  guest.once('did-finish-load', complete)
  guest.once('destroyed', () => guest.off('did-finish-load', complete))
  const promise = waitForBrowserGuestLoad(guest, () =>
    snapshot
      ? guest.navigationHistory.restore({ entries: snapshot.entries, index: snapshot.index })
      : guest.loadURL(url ?? attach.url)
  ).then(() => {
    if (pages.get(attach.pageId) !== page || page.guest !== guest) {
      throw new Error('Browser page replaced')
    }
    complete()
  })
  page.restoring = promise
  guestLoads.set(guest, promise)
  void promise
    .catch(() => {})
    .finally(() => {
      if (page.restoring === promise) {
        page.restoring = null
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
