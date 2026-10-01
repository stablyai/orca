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
    // Firefox is delivered per-target and cannot reach workers; keep it clean-only to preserve one
    // coherent identity per mode instead of pairing a Firefox document with native workers.
    const googleAuthEnabled = processIdentity.mode === 'clean'
    if (
      googleAuthEnabled &&
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
      googleAuthEnabled &&
      !standingOverride &&
      request.effectiveUserAgent === googleAuth.userAgent &&
      (!pendingNavigation || isGoogleAuthUrl(pendingNavigation.currentUrl))
    ) {
      return googleAuth
    }
    if (googleAuthEnabled && standingOverride?.userAgent === googleAuth.userAgent) {
      return googleAuth
    }
    // Shared and service worker requests carry no webContentsId, and resolving a session-wide mobile
    // intent for one put the mobile UA on the wire for a context whose own navigator.userAgent is
    // desktop-clean — and for every tab sharing the session. One context, one identity: those workers
    // stay on the session identity, while emulation reaches documents and the emulated tab's dedicated
    // workers, which carry the owning webContentsId.
    // Why the standing override and not the requested preset: the wire must match what the document
    // presents, and a preset whose CDP write never landed (no debugger, a failed write) presents none.
    return resolveBrowserTabIdentity({
      url: request.url,
      mobile: standingOverride?.userAgentMetadata?.mobile === true,
      processIdentity
    })
  }

  // Why: gate on the DIRECT page id, not ownerTabId — a popup has no device-metrics override of its
  // own, so inheriting the owner tab's preset would pair a mobile UA with a desktop viewport.
  protected hasMobileViewportApplied(guestWebContentsId: number): boolean {
    const browserPageId = this.tabIdByWebContentsId.get(guestWebContentsId)
    const preset = browserPageId ? this.viewportPresetByTabId.get(browserPageId) : undefined
    return preset?.guestWebContentsId === guestWebContentsId && preset.applied?.mobile === true
  }

  /**
   * The only writer of the WebContents UA. Chromium cancels a redirect, and reloads a loading
   * document, when that UA changes at any other moment; a cross-document did-start-navigation is
   * the one point where it lands on the new document alone. Call it synchronously from that event.
   */
  protected presentTabIdentityAtNavigationStart(
    guest: Electron.WebContents,
    url: string,
    sameDocument: boolean
  ): Promise<boolean> {
    const identity = this.resolveGuestTabIdentity(guest, url)
    // The WebContents UA carries no mobile identity: that needs metadata only CDP can send.
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

  /** Every other identity change (redirects, failed loads, preset changes) goes over CDP only. */
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

  // Why clear rather than restate: any override without userAgentMetadata makes Chromium drop
  // navigator.userAgentData and every sec-ch-ua header, so it stands only when the WebContents UA
  // cannot present the identity itself.
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
          : // Only reachable before a navigation start can rewrite the WebContents UA (a redirect
            // off the auth host, a failed load); the next cross-document navigation clears it.
            { userAgent: identity.userAgent }
    if (override.userAgent === '' && !this.standingCdpUserAgentOverride(guest.id)) {
      return Promise.resolve(true)
    }
    // Why: with no debugger there is no way to retarget the identity without cancelling a redirect.
    // A stale navigator.userAgent is recoverable; a dead navigation is not. The wire UA never
    // depended on this write: the session request hook rewrites User-Agent on its own.
    return this.writeCdpUserAgentOverride(guest, override)
  }

  /** The override Chromium holds or is about to hold; undefined when none stands. */
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

  // Why no queue: debugger.sendCommand dispatches in call order over one channel, so the later-issued
  // write wins. The sequence only keeps a failed or superseded write from being recorded as standing.
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

  // Why: webContents.getURL() reports the last COMMITTED url, so mid-navigation it names the host
  // the tab is leaving, not the one it is entering. Every UA writer must resolve the host through
  // here or two writers racing the same navigation will pick opposite identities.
  protected resolveTabNavigationUrl(guest: Electron.WebContents): string {
    return this.pendingNavigationByGuestId.get(guest.id)?.currentUrl ?? guest.getURL()
  }

  /** Route guests own their own popup handler, so their denials arrive here instead. */
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
    const popup = openPopupWithOriginBar(options, targetUrl)
    // Why: Electron emits no did-create-window for createWindow children, so attach the opener's policies here.
    this.attachGuestPolicies(
      popup.contentWebContents,
      this.resolvePopupOwnerContext(openerGuest.id)
    )
    this.forwardOrQueuePopupEvent(openerGuest.id, {
      origin: safeOrigin(targetUrl),
      action: 'opened-in-orca'
    })
    // Why: match Electron's child-window lifecycle so closing the owning tab doesn't orphan session-bearing popups.
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
