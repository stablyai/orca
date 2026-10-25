import { webContents } from 'electron'
import type { BrowserGuestRegistration } from './browser-manager-types'
import { BrowserManagerGuestPolicy } from './browser-manager-guest-policy'
import { desktopWindowId } from '../window/desktop-renderer-registry'

type GuestState = { restore: () => void; detach: () => void }
type NativeGuest = { registration: BrowserGuestRegistration; state: GuestState[] }

function capture<T>(map: Map<string, T>, key: string): GuestState {
  const value = map.get(key)
  return {
    restore: () => {
      if (value === undefined) {
        map.delete(key)
      } else {
        map.set(key, value)
      }
    },
    detach: () => {
      map.delete(key)
    }
  }
}

export abstract class BrowserManagerNativeGuests extends BrowserManagerGuestPolicy {
  private readonly nativeGuests = new Map<string, Map<number, NativeGuest>>()

  private captureNativePage(pageId: string): GuestState[] {
    return [
      capture(this.contextMenuCleanupByTabId, pageId),
      capture(this.grabShortcutCleanupByTabId, pageId),
      capture(this.shortcutForwardingCleanupByTabId, pageId),
      capture(this.mouseWheelZoomCleanupByTabId, pageId)
    ]
  }

  private stashNativePage(pageId: string): NativeGuest | undefined {
    const currentId = this.webContentsIdByTabId.get(pageId)
    const current =
      currentId === undefined ? undefined : this.nativeGuests.get(pageId)?.get(currentId)
    if (current) {
      current.state = this.captureNativePage(pageId)
      for (const item of current.state) {
        item.detach()
      }
    }
    return current
  }

  protected rememberNativeGuest(
    pageId: string,
    registration: BrowserGuestRegistration,
    options?: { retainPreviousGuestPolicies?: boolean }
  ): boolean {
    const renderer = webContents.fromId(registration.rendererWebContentsId)
    if (!renderer || !desktopWindowId(renderer)) {
      return false
    }
    const guests = this.nativeGuests.get(pageId) ?? new Map<number, NativeGuest>()
    for (const [id, entry] of guests) {
      if (
        id !== registration.webContentsId &&
        entry.registration.rendererWebContentsId === registration.rendererWebContentsId &&
        !options?.retainPreviousGuestPolicies
      ) {
        this.selectNativeGuest(pageId, id, true)
        this.unregisterGuest(pageId, 'guest-destroyed')
      }
    }
    const currentId = this.webContentsIdByTabId.get(pageId)
    const current =
      currentId === undefined ? undefined : this.nativeGuests.get(pageId)?.get(currentId)
    const preservePeer = Boolean(
      current &&
      current.registration.webContentsId !== registration.webContentsId &&
      (current.registration.rendererWebContentsId !== registration.rendererWebContentsId ||
        options?.retainPreviousGuestPolicies)
    )
    if (preservePeer) {
      this.stashNativePage(pageId)
    }
    guests.set(registration.webContentsId, { registration, state: [] })
    this.nativeGuests.set(pageId, guests)
    this.nativeRendererByGuestId.set(registration.webContentsId, registration.rendererWebContentsId)
    return preservePeer
  }

  protected saveNativeGuestState(pageId: string): void {
    const id = this.webContentsIdByTabId.get(pageId)
    const entry = id === undefined ? undefined : this.nativeGuests.get(pageId)?.get(id)
    if (entry) {
      entry.state = this.captureNativePage(pageId)
    }
  }

  private selectNativeGuest(pageId: string, guestId: number, allowDestroyed = false): void {
    const entry = this.nativeGuests.get(pageId)?.get(guestId)
    const guest = webContents.fromId(guestId)
    if (
      !entry ||
      (!allowDestroyed && (!guest || guest.isDestroyed())) ||
      this.webContentsIdByTabId.get(pageId) === guestId
    ) {
      return
    }
    this.stashNativePage(pageId)
    for (const item of entry.state) {
      item.restore()
    }
    const registration = entry.registration
    this.webContentsIdByTabId.set(pageId, guestId)
    this.rendererWebContentsIdByTabId.set(pageId, registration.rendererWebContentsId)
    if (registration.workspaceId) {
      this.workspaceIdByPageId.set(pageId, registration.workspaceId)
    }
    if (registration.worktreeId) {
      this.worktreeIdByTabId.set(pageId, registration.worktreeId)
    }
    this.sessionProfileIdByPageId.set(pageId, registration.sessionProfileId ?? null)
  }

  selectNativeRenderer(rendererId: number): void {
    for (const [pageId, guests] of this.nativeGuests) {
      const owned = [...guests].findLast(
        ([, entry]) => entry.registration.rendererWebContentsId === rendererId
      )
      if (owned) {
        this.selectNativeGuest(pageId, owned[0])
      }
    }
  }

  /** Unregisters exactly the caller's own guest; a peer's guest stays selected and live. */
  unregisterGuestForRenderer(
    pageId: string,
    rendererId: number,
    reason: 'page-closed' | 'guest-destroyed' = 'page-closed'
  ): boolean {
    const targetId = this.guestIdForRenderer(pageId, rendererId)
    if (targetId === undefined) {
      return false
    }
    const previouslySelectedId = this.webContentsIdByTabId.get(pageId)
    const guests = this.nativeGuests.get(pageId)
    if (guests) {
      // unregisterGuest always tears down whichever guest is currently selected; aim it at the caller's own guest.
      this.selectNativeGuest(pageId, targetId, true)
    }
    this.unregisterGuest(pageId, reason)
    if (guests && previouslySelectedId !== undefined && previouslySelectedId !== targetId) {
      this.selectNativeGuest(pageId, previouslySelectedId)
    }
    return true
  }

  protected override guestIdForRenderer(pageId: string, rendererId: number): number | undefined {
    const guests = this.nativeGuests.get(pageId)
    if (!guests) {
      return super.guestIdForRenderer(pageId, rendererId)
    }
    return [...guests].findLast(
      ([, entry]) => entry.registration.rendererWebContentsId === rendererId
    )?.[0]
  }

  protected selectGuestForEvent(guestId: number): void {
    const pageId = this.tabIdByWebContentsId.get(guestId)
    if (pageId) {
      this.selectNativeGuest(pageId, guestId, true)
    }
  }

  protected forgetNativeGuest(pageId: string): void {
    const id = this.webContentsIdByTabId.get(pageId)
    if (id === undefined) {
      return
    }
    this.nativeGuests.get(pageId)?.delete(id)
    this.nativeRendererByGuestId.delete(id)
  }

  protected restoreNativePeer(pageId: string): void {
    const guests = this.nativeGuests.get(pageId)
    if (!guests?.size) {
      this.nativeGuests.delete(pageId)
      return
    }
    for (const id of guests.keys()) {
      const guest = webContents.fromId(id)
      if (guest && !guest.isDestroyed()) {
        this.selectNativeGuest(pageId, id)
        return
      }
    }
  }

  protected unregisterAllNativeGuests(): void {
    for (const [pageId, guests] of this.nativeGuests) {
      for (const id of guests.keys()) {
        this.selectNativeGuest(pageId, id, true)
        this.unregisterGuest(pageId)
      }
    }
  }
}
