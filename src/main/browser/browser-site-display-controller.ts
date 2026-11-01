import { acquireElectronDebugger, type ElectronDebuggerLease } from './electron-debugger-lease'
import { getBrowserSiteDisplay, updateBrowserSiteDisplay } from './browser-site-display-store'
import {
  browserSiteDisplayKey,
  type BrowserPageSiteDisplay,
  type BrowserSiteColorScheme
} from '../../shared/browser-site-display'
import {
  DEFAULT_BROWSER_PAGE_ZOOM_LEVEL,
  nextBrowserPageZoomLevel,
  normalizeBrowserPageZoomLevel,
  type BrowserPageZoomDirection
} from '../../shared/browser-page-zoom'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import { errorMessage } from '../../shared/error-message'

type TrackedGuest = {
  guest: Electron.WebContents
  profileId: string
  stopWatchingDomReady: () => void
  colorScheme: {
    lease: ElectronDebuggerLease
    stopWatchingDetach: () => void
    /** An active site override must be cleared when leaving the site. */
    standing: boolean
  } | null
}

const ZOOM_EPSILON = 1e-6

export class BrowserSiteDisplayController {
  private readonly guests = new Map<number, TrackedGuest>()
  private defaultZoomLevel = DEFAULT_BROWSER_PAGE_ZOOM_LEVEL

  /** Restore page zoom when Electron propagates an Orca UI zoom change to webviews. */
  followZoomSettings(ui: {
    getUI: () => PersistedUIState
    onUIChanged: (listener: (ui: PersistedUIState) => void) => () => void
  }): void {
    let { uiZoomLevel, browserDefaultZoomLevel } = ui.getUI()
    this.defaultZoomLevel = normalizeBrowserPageZoomLevel(browserDefaultZoomLevel)
    ui.onUIChanged((next) => {
      if (
        next.uiZoomLevel === uiZoomLevel &&
        next.browserDefaultZoomLevel === browserDefaultZoomLevel
      ) {
        return
      }
      ;({ uiZoomLevel, browserDefaultZoomLevel } = next)
      this.defaultZoomLevel = normalizeBrowserPageZoomLevel(browserDefaultZoomLevel)
      this.reapplyZoom()
    })
  }

  onGuestRegistered(guest: Electron.WebContents, profileId: string | null): void {
    const previous = this.guests.get(guest.id)
    previous?.stopWatchingDomReady()
    // dom-ready follows Electron's post-commit copy of the embedder zoom.
    const onDomReady = (): void => this.applyZoom(guest.id)
    guest.on('dom-ready', onDomReady)
    this.guests.set(guest.id, {
      guest,
      profileId: profileId ?? 'default',
      stopWatchingDomReady: () => guest.off('dom-ready', onDomReady),
      colorScheme: previous?.colorScheme ?? null
    })
    this.applyColorScheme(guest.id)
    this.applyZoom(guest.id)
  }

  onGuestRetired(guestId: number): void {
    this.releaseColorScheme(guestId)
    const tracked = this.guests.get(guestId)
    if (tracked && !tracked.guest.isDestroyed()) {
      tracked.stopWatchingDomReady()
    }
    this.guests.delete(guestId)
  }

  // Apply the committed site's scheme before document scripts read prefers-color-scheme.
  onMainFrameNavigationCommitted(guestId: number): void {
    this.applyColorScheme(guestId)
    this.applyZoom(guestId)
  }

  private reapplyZoom(): void {
    for (const guestId of this.guests.keys()) {
      this.applyZoom(guestId)
    }
  }

  getPageDisplay(guestId: number): BrowserPageSiteDisplay | null {
    const tracked = this.guests.get(guestId)
    if (!tracked) {
      return null
    }
    const site = browserSiteDisplayKey(tracked.guest.getURL())
    const saved = site ? getBrowserSiteDisplay(tracked.profileId, site) : {}
    return {
      site,
      zoomLevel: saved.zoomLevel ?? this.defaultZoomLevel,
      siteHasZoom: saved.zoomLevel !== undefined,
      colorScheme: saved.colorScheme ?? null
    }
  }

  zoomPage(guestId: number, direction: BrowserPageZoomDirection): BrowserPageSiteDisplay | null {
    const display = this.getPageDisplay(guestId)
    const profileId = this.guests.get(guestId)?.profileId
    if (!display?.site || !profileId) {
      return display
    }
    // Step from saved zoom; Electron may have overwritten the live level with Orca UI zoom.
    const next = nextBrowserPageZoomLevel(display.zoomLevel, direction, this.defaultZoomLevel)
    const zoomLevel = next === this.defaultZoomLevel ? undefined : next
    if (zoomLevel !== (display.siteHasZoom ? display.zoomLevel : undefined)) {
      updateBrowserSiteDisplay(profileId, display.site, { zoomLevel })
      this.forEachSiteGuest(profileId, display.site, (siteGuestId) => this.applyZoom(siteGuestId))
    }
    return this.getPageDisplay(guestId)
  }

  setColorScheme(
    guestId: number,
    colorScheme: BrowserSiteColorScheme | null
  ): BrowserPageSiteDisplay | null {
    const display = this.getPageDisplay(guestId)
    const profileId = this.guests.get(guestId)?.profileId
    if (!display?.site || !profileId || display.colorScheme === colorScheme) {
      return display
    }
    updateBrowserSiteDisplay(profileId, display.site, { colorScheme: colorScheme ?? undefined })
    this.forEachSiteGuest(profileId, display.site, (siteGuestId) =>
      this.applyColorScheme(siteGuestId)
    )
    return this.getPageDisplay(guestId)
  }

  private forEachSiteGuest(
    profileId: string,
    site: string,
    apply: (guestId: number) => void
  ): void {
    for (const [guestId, tracked] of this.guests) {
      if (
        tracked.profileId === profileId &&
        browserSiteDisplayKey(tracked.guest.getURL()) === site
      ) {
        apply(guestId)
      }
    }
  }

  private applyZoom(guestId: number): void {
    const tracked = this.guests.get(guestId)
    if (!tracked || tracked.guest.isDestroyed()) {
      return
    }
    const level = this.getPageDisplay(guestId)?.zoomLevel ?? this.defaultZoomLevel
    // Chromium shares zoom per host; avoid no-op writes that can reset another profile's tab.
    if (Math.abs(tracked.guest.getZoomLevel() - level) > ZOOM_EPSILON) {
      tracked.guest.setZoomLevel(level)
    }
  }

  private applyColorScheme(guestId: number): void {
    const tracked = this.guests.get(guestId)
    if (!tracked || tracked.guest.isDestroyed()) {
      return
    }
    const colorScheme = this.getPageDisplay(guestId)?.colorScheme ?? undefined
    if (!colorScheme && !tracked.colorScheme?.standing) {
      return
    }
    const state = tracked.colorScheme ?? this.acquireColorScheme(tracked)
    if (!state) {
      return
    }
    state.standing = colorScheme !== undefined
    // Reapply on navigation because an agent's setEmulatedMedia replaces all emulated features.
    tracked.guest.debugger
      .sendCommand('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: colorScheme ?? '' }]
      })
      .catch((error: unknown) => {
        console.warn('[browser-site-display] failed to set the page color scheme', {
          guestWebContentsId: guestId,
          error: errorMessage(error)
        })
      })
  }

  // Keep a lifetime lease so an agent releasing its earlier lease cannot clear the scheme.
  private acquireColorScheme(tracked: TrackedGuest): TrackedGuest['colorScheme'] {
    const { guest } = tracked
    let lease: ElectronDebuggerLease
    try {
      lease = acquireElectronDebugger(guest)
    } catch (error) {
      // DevTools can prevent attachment; retry on the next navigation.
      console.warn('[browser-site-display] could not attach to set the page color scheme', {
        guestWebContentsId: guest.id,
        error: errorMessage(error)
      })
      return null
    }
    // DevTools detachment clears emulation; reacquire the lease on the next navigation.
    const onDetach = (): void => this.releaseColorScheme(guest.id)
    guest.debugger.on('detach', onDetach)
    tracked.colorScheme = {
      lease,
      stopWatchingDetach: () => guest.debugger.off('detach', onDetach),
      standing: false
    }
    return tracked.colorScheme
  }

  private releaseColorScheme(guestId: number): void {
    const tracked = this.guests.get(guestId)
    const state = tracked?.colorScheme
    if (!tracked || !state) {
      return
    }
    tracked.colorScheme = null
    try {
      state.stopWatchingDetach()
      state.lease.release()
    } catch {
      // The guest may already be destroyed.
    }
  }
}

export const browserSiteDisplayController = new BrowserSiteDisplayController()
