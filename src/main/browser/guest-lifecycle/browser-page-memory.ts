import { BrowserError } from '../browser-error'
import { isAgentRpcCaller } from '../../runtime/rpc/rpc-caller-identity'
import { getActiveRpcCaller } from '../../runtime/rpc/rpc-active-caller'
import { readBrowserGuestDiscardProtection } from './manager/registration/browser-guest-discard-protection'
import { waitForBrowserGuestLoad } from './browser-guest-load'
import {
  claims,
  pages,
  retiredGuests,
  renewHeldThrottle,
  type History,
  type Claim
} from './browser-page-memory-state'
import { forgetBrowserPageAttach, guestLoads } from './browser-page-attach'
export {
  prepareBrowserPageAttach,
  admitBrowserPageAttach,
  isBrowserPageAttachMarker,
  associateBrowserPageAttach,
  startBrowserPageAttach,
  hasPendingBrowserPageAttach
} from './browser-page-attach'

export function bindBrowserPageMemoryInvalidation(
  pageId: string,
  guest: Electron.WebContents,
  rendererId: number,
  changed: () => void
): void {
  const page = pages.get(pageId)
  if (page?.guest !== guest || page.rendererId !== rendererId) {
    return
  }
  page.invalidation = {
    guest,
    notify: () => {
      if (pages.get(pageId) === page && page.guest === guest && page.rendererId === rendererId) {
        try {
          changed()
        } catch {
          // A disposed renderer must not fail a page operation's release.
        }
      }
    }
  }
}

export function clearBrowserPageMemoryInvalidation(pageId: string, guestId: number): void {
  const page = pages.get(pageId)
  if (page?.invalidation?.guest.id === guestId) {
    delete page.invalidation
  }
}

export function claimBrowserMemoryPage(pageId: string): () => void {
  let claim = claims.get(pageId)
  if (!claim) {
    claim = { held: false, operations: 0 }
    claims.set(pageId, claim)
  }
  claim.operations++
  if (pages.has(pageId) && isAgentRpcCaller(getActiveRpcCaller())) {
    claim.held = true
  }
  const page = pages.get(pageId)
  if (page) {
    renewHeldThrottle(page)
  }
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    claim.operations--
    const current = pages.get(pageId)
    if (!claim.operations && current?.claim === claim) {
      current.invalidation?.notify()
    }
    if (
      !claim.operations &&
      !pages.has(pageId) &&
      claim.pendingRendererId === undefined &&
      claims.get(pageId) === claim
    ) {
      claims.delete(pageId)
    }
  }
}

export function retainBrowserMemoryPageForAgent(
  pageId: string,
  creator?: Electron.WebContents
): void {
  if (!isAgentRpcCaller(getActiveRpcCaller()) || creator?.isDestroyed()) {
    return
  }
  const claim: Claim = claims.get(pageId) ?? { held: false, operations: 0 }
  if (creator && !pages.has(pageId)) {
    claim.pendingRendererId = creator.id
  }
  claim.held = true
  claims.set(pageId, claim)
  const page = pages.get(pageId)
  if (page) {
    renewHeldThrottle(page)
  }
}

export function closeBrowserMemoryRenderer(rendererId: number): void {
  for (const [pageId, claim] of claims) {
    if (!pages.has(pageId) && claim.pendingRendererId === rendererId) {
      claims.delete(pageId)
    }
  }
  for (const [pageId, page] of pages) {
    if (page.rendererId === rendererId) {
      closeBrowserMemoryPage(pageId)
    }
  }
}

export function isRetiredBrowserGuest(pageId: string, guestId: number): boolean {
  return pages.get(pageId)?.retired.has(guestId) === true
}

export function reserveBrowserPageDiscard(pageId: string, guest: Electron.WebContents): boolean {
  const page = pages.get(pageId)
  if (
    !page ||
    page.guest !== guest ||
    page.claim.held ||
    page.claim.operations ||
    page.restoring ||
    page.retired.size ||
    guest.isDestroyed() ||
    guest.isLoading() ||
    guest.isDevToolsOpened() ||
    guest.debugger.isAttached() ||
    readBrowserGuestDiscardProtection(guest).protection !== 'discardable'
  ) {
    return false
  }
  let history: History
  try {
    // Project immediately: opaque native page state never enters the cold record.
    const entries = guest.navigationHistory
      .getAllEntries()
      .map((entry) => ({ url: entry.url, title: entry.title }))
    const index = guest.navigationHistory.getActiveIndex()
    if (
      !entries.length ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= entries.length ||
      entries.some((entry) => !entry.url)
    ) {
      return false
    }
    history = { entries, index }
  } catch {
    return false
  }
  page.history = history
  page.retired.set(guest.id, { guest, rendererId: page.rendererId })
  retiredGuests.set(guest.id, { pageId, guest, rendererId: page.rendererId })
  page.guest = null
  delete page.invalidation
  page.releaseThrottle?.()
  page.releaseThrottle = null
  return true
}

export async function acknowledgeBrowserPageRemoval(
  pageId: string,
  guest: Electron.WebContents,
  rendererId: number
): Promise<boolean> {
  const page = pages.get(pageId)
  const retired = retiredGuests.get(guest.id)
  if (
    !retired ||
    retired.pageId !== pageId ||
    retired.guest !== guest ||
    retired.rendererId !== rendererId
  ) {
    return false
  }
  if (!guest.isDestroyed()) {
    await new Promise<void>((resolve) => {
      guest.once('destroyed', resolve)
      guest.close({ waitForBeforeUnload: false })
    })
  }
  if (page?.retired.delete(guest.id)) {
    page.invalidation?.notify()
  }
  retiredGuests.delete(guest.id)
  return true
}

export function closeBrowserMemoryPage(pageId: string): void {
  const page = pages.get(pageId)
  claims.delete(pageId)
  if (!page) {
    return
  }
  page.releaseThrottle?.()
  forgetBrowserPageAttach(page)
  pages.delete(pageId)
  for (const retired of page.retired.values()) {
    if (!retired.guest.isDestroyed()) {
      retired.guest.close({ waitForBeforeUnload: false })
    }
  }
}

export function browserMemoryGeneration(pageId: string): number | undefined {
  return pages.get(pageId)?.generation
}

export async function waitForBrowserPageReady(
  pageId: string,
  guest: Electron.WebContents,
  recoverFromLoadError = false
): Promise<void> {
  if (isRetiredBrowserGuest(pageId, guest.id)) {
    throw new BrowserError('browser_no_tab', 'The browser page is restoring')
  }
  const page = pages.get(pageId)
  const load = guestLoads.get(guest)
  if (load) {
    try {
      await load
    } catch (error) {
      if (!recoverFromLoadError) {
        throw error
      }
    }
  } else if (page?.history && !recoverFromLoadError) {
    throw new BrowserError(
      'browser_navigation_failed',
      'The browser page could not be restored. Try reloading it.'
    )
  } else if (guest.isLoading()) {
    await waitForBrowserGuestLoad(guest)
  }
}
