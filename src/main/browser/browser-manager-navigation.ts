import { openPopupWithOriginBar, type PopupChildWindowOptions } from './popup-origin-bar-window'
import { getBrowserProcessUserAgentIdentity } from './browser-process-user-agent'
import type { BrowserSessionRequestUserAgentResolver } from './browser-session-ua'
import { isGoogleAuthUrl } from './browser-google-auth-ua'
import {
  googleAuthTabIdentity,
  resolveBrowserTabIdentity,
  type BrowserTabIdentity
} from './browser-tab-identity'
import {
  safeOrigin,
  type CdpUserAgentOverride,
  type CdpUserAgentOverrideOperation,
  type CdpUserAgentOverrideState
} from './browser-manager-types'
import { BrowserManagerVisibility } from './browser-manager-visibility'

export abstract class BrowserManagerNavigation extends BrowserManagerVisibility {
  resolveBrowserGuestRequestUserAgent(
    request: Parameters<BrowserSessionRequestUserAgentResolver>[0]
  ): BrowserTabIdentity {
    const processIdentity = getBrowserProcessUserAgentIdentity()
    const googleAuth = googleAuthTabIdentity()
    const pendingNavigation =
      request.webContentsId === undefined
        ? undefined
        : this.pendingNavigationByGuestId.get(request.webContentsId)
    // Only a UA distinct from the process UA can mark a request as part of sign-in.
    const authUaIsDistinct = googleAuth.userAgent !== processIdentity.userAgent
    if (
      authUaIsDistinct &&
      request.currentUserAgent === googleAuth.userAgent &&
      (!pendingNavigation || isGoogleAuthUrl(pendingNavigation.currentUrl))
    ) {
      return googleAuth
    }
    const standingOverride =
      request.webContentsId === undefined
        ? undefined
        : this.standingCdpUserAgentOverride(request.webContentsId)
    if (
      authUaIsDistinct &&
      !standingOverride &&
      request.effectiveUserAgent === googleAuth.userAgent &&
      (!pendingNavigation || isGoogleAuthUrl(pendingNavigation.currentUrl))
    ) {
      return googleAuth
    }
    if (authUaIsDistinct && standingOverride?.userAgent === googleAuth.userAgent) {
      return googleAuth
    }
    // Shared/service workers lack a guest ID and retain the process identity.
    // Derive mobile identity from the standing override, never an unapplied preset.
    return resolveBrowserTabIdentity({
      url: request.url,
      mobile: standingOverride?.userAgentMetadata?.mobile === true,
      processIdentity
    })
  }

  // Popups have no device-metrics override; never inherit the opener tab's mobile identity.
  protected hasMobileViewportApplied(guestWebContentsId: number): boolean {
    const browserPageId = this.tabIdByWebContentsId.get(guestWebContentsId)
    const preset = browserPageId ? this.viewportPresetByTabId.get(browserPageId) : undefined
    return preset?.guestWebContentsId === guestWebContentsId && preset.applied?.mobile === true
  }

  /** Write synchronously at cross-document navigation start; later UA writes can abort or reload. */
  protected presentTabIdentityAtNavigationStart(
    guest: Electron.WebContents,
    url: string,
    sameDocument: boolean
  ): Promise<boolean> {
    const identity = this.resolveGuestTabIdentity(guest, url)
    // Mobile identity needs CDP metadata that setUserAgent cannot supply.
    const webContentsUserAgent =
      identity.kind === 'google-auth'
        ? identity.userAgent
        : getBrowserProcessUserAgentIdentity().userAgent
    let presentedByWebContents = guest.getUserAgent()
    if (!sameDocument && presentedByWebContents !== webContentsUserAgent) {
      guest.setUserAgent(webContentsUserAgent)
      presentedByWebContents = webContentsUserAgent
    }
    return this.writeTabIdentityOverride(guest, identity, presentedByWebContents)
  }

  protected retargetTabIdentity(guest: Electron.WebContents, url: string): Promise<boolean> {
    return this.writeTabIdentityOverride(
      guest,
      this.resolveGuestTabIdentity(guest, url),
      guest.getUserAgent()
    )
  }

  private resolveGuestTabIdentity(guest: Electron.WebContents, url: string): BrowserTabIdentity {
    return resolveBrowserTabIdentity({
      url,
      mobile: this.hasMobileViewportApplied(guest.id),
      processIdentity: getBrowserProcessUserAgentIdentity()
    })
  }

  // Clear redundant overrides to preserve client hints; UA-only CDP overrides suppress them.
  private writeTabIdentityOverride(
    guest: Electron.WebContents,
    identity: BrowserTabIdentity,
    presentedByWebContents: string
  ): Promise<boolean> {
    const override: CdpUserAgentOverride =
      identity.kind === 'mobile'
        ? { userAgent: identity.userAgent, userAgentMetadata: identity.userAgentMetadata }
        : presentedByWebContents === identity.userAgent
          ? { userAgent: '' }
          : // Temporary override until cross-document navigation can update the WebContents UA.
            { userAgent: identity.userAgent }
    if (override.userAgent === '' && !this.standingCdpUserAgentOverride(guest.id)) {
      return Promise.resolve(true)
    }
    // Without CDP, leave navigation intact; session hooks still rewrite the request UA.
    return this.writeCdpUserAgentOverride(guest, override)
  }

  /** Includes pending writes; undefined when no nonempty override stands. */
  protected standingCdpUserAgentOverride(guestId: number): CdpUserAgentOverride | undefined {
    const state = this.cdpUserAgentOverrideStateByGuestId.get(guestId)
    const latestPending = state?.pending.at(-1)
    const current =
      latestPending && latestPending.sequence > (state?.confirmed?.sequence ?? -1)
        ? latestPending
        : state?.confirmed
    return current && current.override.userAgent !== '' ? current.override : undefined
  }

  protected canOverrideUserAgentOverCdp(guest: Electron.WebContents): boolean {
    try {
      return !guest.isDestroyed() && guest.debugger.isAttached()
    } catch {
      return false
    }
  }

  // CDP dispatches writes in order; sequence tracking keeps stale completions from replacing newer state.
  protected writeCdpUserAgentOverride(
    guest: Electron.WebContents,
    override: CdpUserAgentOverride
  ): Promise<boolean> {
    if (!this.canOverrideUserAgentOverCdp(guest)) {
      return Promise.resolve(false)
    }
    const state = this.cdpUserAgentOverrideStateByGuestId.get(guest.id) ?? {
      confirmed: null,
      nextSequence: 0,
      pending: []
    }
    const operation = { sequence: ++state.nextSequence, override }
    state.pending.push(operation)
    this.cdpUserAgentOverrideStateByGuestId.set(guest.id, state)
    return guest.debugger.sendCommand('Emulation.setUserAgentOverride', override).then(
      () => this.settleCdpUserAgentOverride(guest.id, state, operation, true),
      (error: unknown) => {
        this.settleCdpUserAgentOverride(guest.id, state, operation, false)
        console.warn('[browser-manager] failed to write the tab user agent override', {
          guestWebContentsId: guest.id,
          error: error instanceof Error ? error.message : String(error)
        })
        return false
      }
    )
  }

  protected settleCdpUserAgentOverride(
    guestId: number,
    state: CdpUserAgentOverrideState,
    operation: CdpUserAgentOverrideOperation,
    succeeded: boolean
  ): boolean {
    if (this.cdpUserAgentOverrideStateByGuestId.get(guestId) !== state) {
      return false
    }
    if (succeeded && (state.confirmed?.sequence ?? -1) < operation.sequence) {
      state.confirmed = operation
    }
    const pendingIndex = state.pending.indexOf(operation)
    if (pendingIndex !== -1) {
      state.pending.splice(pendingIndex, 1)
    }
    if (
      (state.confirmed === null || state.confirmed.override.userAgent === '') &&
      state.pending.length === 0
    ) {
      this.cdpUserAgentOverrideStateByGuestId.delete(guestId)
    }
    return succeeded
  }

  protected startPendingNavigation(guestId: number, url: string): void {
    const pending = this.pendingNavigationByGuestId.get(guestId)
    this.pendingNavigationByGuestId.set(guestId, {
      currentUrl: url,
      supersededUrls: pending ? [...pending.supersededUrls, pending.currentUrl] : []
    })
  }

  protected updatePendingNavigationForRedirect(guestId: number, url: string): void {
    const pending = this.pendingNavigationByGuestId.get(guestId)
    if (!pending) {
      this.pendingNavigationByGuestId.set(guestId, {
        currentUrl: url,
        supersededUrls: []
      })
      return
    }
    pending.currentUrl = url
  }

  protected failPendingNavigation(guestId: number, failedUrl: string): boolean {
    const pending = this.pendingNavigationByGuestId.get(guestId)
    if (!pending) {
      return false
    }
    const supersededIndex = pending.supersededUrls.indexOf(failedUrl)
    if (supersededIndex !== -1) {
      pending.supersededUrls.splice(supersededIndex, 1)
      return false
    }
    if (pending.currentUrl !== failedUrl) {
      return false
    }
    this.pendingNavigationByGuestId.delete(guestId)
    return true
  }

  // Resolve in-flight targets before getURL(), which still names the outgoing document.
  protected resolveTabNavigationUrl(guest: Electron.WebContents): string {
    return this.pendingNavigationByGuestId.get(guest.id)?.currentUrl ?? guest.getURL()
  }

  reportRouteGuestPopupBlocked(input: { openerWebContentsId: number; url: string }): void {
    this.forwardOrQueuePopupEvent(input.openerWebContentsId, {
      origin: safeOrigin(input.url),
      action: 'blocked'
    })
  }

  protected createPopupChildWindowWithOriginBar(
    openerGuest: Electron.WebContents,
    targetUrl: string,
    options: PopupChildWindowOptions
  ): Electron.WebContents {
    const popup = openPopupWithOriginBar(options, targetUrl, (contents) => {
      if (openerGuest.isDestroyed() || contents.session !== openerGuest.session) {
        return false
      }
      const owner = this.resolvePopupOwnerContext(openerGuest.id)
      if (!owner) {
        return false
      }
      this.attachGuestPolicies(contents, owner)
      return true
    })
    const opened = Boolean(options.webContents || options.nativeWindow)
    this.forwardOrQueuePopupEvent(openerGuest.id, {
      origin: safeOrigin(targetUrl),
      action: opened ? 'opened-in-orca' : 'blocked'
    })
    const ownerTabId = this.resolveBrowserTabIdForGuestWebContentsId(openerGuest.id)
    if (opened && ownerTabId) {
      this.pageEvents.emit(ownerTabId, {
        kind: 'popup',
        action: 'window',
        origin: safeOrigin(targetUrl)
      })
    }
    // Close session-bearing popups with their owning guest to avoid orphan windows.
    const closePopupWithOpener = (): void => popup.close()
    openerGuest.once('destroyed', closePopupWithOpener)
    popup.onClosed(() => {
      if (!openerGuest.isDestroyed()) {
        openerGuest.off('destroyed', closePopupWithOpener)
      }
    })
    return popup.contentWebContents
  }
}
