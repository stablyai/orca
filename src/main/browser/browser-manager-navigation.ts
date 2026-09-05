import { openPopupWithOriginBar, type PopupChildWindowOptions } from './popup-origin-bar-window'
import { cleanElectronUserAgent } from './browser-session-ua'
import { getBrowserSessionUserAgentMode } from './browser-session-user-agent-mode'
import { googleAuthUserAgent, isGoogleAuthUrl } from './browser-google-auth-ua'
import { buildViewportUserAgentOverride } from './browser-viewport-user-agent'
import {
  safeOrigin,
  type AuthUserAgentOverrideOperation,
  type AuthUserAgentOverrideState
} from './browser-manager-types'
import { BrowserManagerVisibility } from './browser-manager-visibility'

export abstract class BrowserManagerNavigation extends BrowserManagerVisibility {
  // Why: navigator.userAgent (read by Google's auth JS) reflects the WebContents UA,
  // not the request header, so the header-level Firefox switch in setupClientHintsOverride
  // must be matched here per navigation or the two layers disagree — itself a bot tell.
  // Restores the session's base identity off the auth hosts. Native-UA profiles opt out
  // of the whole clean-UA path, so they keep their untouched identity everywhere.
  protected applyGoogleAuthUserAgent(
    guest: Electron.WebContents,
    url: string,
    options: { duringRedirect?: boolean } = {}
  ): void {
    const browserPageId = this.tabIdByWebContentsId.get(guest.id)
    // Why: popup child windows get these policies but are never in tabIdByWebContentsId, so a direct
    // lookup misses the native-UA opt-out and would hand a native profile's popup the Firefox UA.
    // That is worse than doing nothing: native sessions skip setupClientHintsOverride entirely, so
    // the popup would send the raw Electron UA on the wire while navigator.userAgent claims Firefox.
    const ownerTabId = this.resolveBrowserTabIdForGuestWebContentsId(guest.id)
    // Session state is authoritative before renderer registration and after a native profile imports a source UA.
    const mode =
      getBrowserSessionUserAgentMode(guest.session) ??
      (ownerTabId ? this.userAgentModeByPageId.get(ownerTabId) : undefined)
    if (mode === 'native') {
      return
    }
    const firefoxUa = googleAuthUserAgent()
    const overrideState = this.authUserAgentOverrideStateByGuestId.get(guest.id)
    const latestPendingOverride = overrideState?.pending.at(-1)
    const confirmedOverride = overrideState?.confirmed
    const currentOverride =
      latestPendingOverride && latestPendingOverride.sequence > (confirmedOverride?.sequence ?? -1)
        ? latestPendingOverride
        : confirmedOverride
    const currentUa = currentOverride?.userAgent ?? guest.getUserAgent()
    const nextUa = isGoogleAuthUrl(url)
      ? firefoxUa
      : // Only restore when the auth-host override is actually in place, so normal
        // navigation never touches the session UA.
        currentUa === firefoxUa
        ? guest.session.getUserAgent()
        : null
    let authOverrideIssuedOverCdp = false
    if (nextUa !== null && nextUa !== currentUa) {
      // Why: WebContents.setUserAgent() during a redirect makes Chromium cancel the in-flight
      // navigation (ERR_ABORTED) and replay the original request, which a POST-started OAuth chain
      // cannot survive — the sign-in lands on a blank tab. CDP retargets navigator.userAgent without
      // touching the navigation, and it outranks the WebContents UA from then on, so a guest that
      // switches to it stays on it. The wire UA never depended on this write: setupClientHintsOverride
      // rewrites User-Agent per request for auth-host URLs on its own.
      if (options.duringRedirect === true || overrideState !== undefined) {
        if (this.canOverrideUserAgentOverCdp(guest)) {
          authOverrideIssuedOverCdp = true
          // Why: go through the viewport builder rather than writing nextUa raw, so both CDP writers
          // resolve one identity for this URL — Firefox on auth hosts, the profile's clean base off
          // them, any mobile preset preserved. Writing the session UA directly would put the
          // unlaundered Electron token back on the wire.
          void this.applyAuthUserAgentOverrideOverCdp(
            guest,
            (browserPageId ? this.viewportUaOverrideMobileByTabId.get(browserPageId) : undefined) ??
              false,
            url,
            nextUa
          )
        }
        // Why: with no debugger there is no way to retarget the identity without cancelling the
        // redirect. A stale navigator.userAgent is recoverable; a dead navigation is not.
      } else {
        guest.setUserAgent(nextUa)
      }
    }
    // Why: gate on the DIRECT page id, not ownerTabId — a popup has no device-metrics override of
    // its own, so inheriting the owner tab's preset UA would pair a mobile UA with a desktop viewport.
    if (browserPageId && !authOverrideIssuedOverCdp) {
      this.reapplyViewportUserAgentOverride(guest, browserPageId, url)
    }
  }

  protected canOverrideUserAgentOverCdp(guest: Electron.WebContents): boolean {
    try {
      return !guest.isDestroyed() && guest.debugger.isAttached()
    } catch {
      return false
    }
  }

  protected applyAuthUserAgentOverrideOverCdp(
    guest: Electron.WebContents,
    mobile: boolean,
    url: string,
    userAgent: string
  ): Promise<boolean> {
    if (!this.canOverrideUserAgentOverCdp(guest)) {
      return Promise.resolve(false)
    }
    const state = this.authUserAgentOverrideStateByGuestId.get(guest.id) ?? {
      confirmed: null,
      nextSequence: 0,
      pending: []
    }
    const operation = { sequence: ++state.nextSequence, userAgent }
    state.pending.push(operation)
    this.authUserAgentOverrideStateByGuestId.set(guest.id, state)
    return this.sendViewportUserAgentOverride(guest, mobile, url, userAgent).then(
      () => this.settleAuthUserAgentOverride(guest.id, state, operation, true),
      () => {
        this.settleAuthUserAgentOverride(guest.id, state, operation, false)
        return false
      }
    )
  }

  protected settleAuthUserAgentOverride(
    guestId: number,
    state: AuthUserAgentOverrideState,
    operation: AuthUserAgentOverrideOperation,
    succeeded: boolean
  ): boolean {
    if (this.authUserAgentOverrideStateByGuestId.get(guestId) !== state) {
      return false
    }
    if (succeeded && (state.confirmed?.sequence ?? -1) < operation.sequence) {
      state.confirmed = operation
    }
    const pendingIndex = state.pending.indexOf(operation)
    if (pendingIndex !== -1) {
      state.pending.splice(pendingIndex, 1)
    }
    if (state.confirmed === null && state.pending.length === 0) {
      this.authUserAgentOverrideStateByGuestId.delete(guestId)
    }
    return true
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

  // Why: Emulation.setUserAgentOverride is set once and stands across every later navigation,
  // outranking setUserAgent for navigator.userAgent. A viewport preset applied before reaching an
  // auth host would otherwise pin navigator.userAgent to the Chrome-shaped preset UA while the
  // request header says Firefox — the two-layer disagreement this scope exists to remove.
  protected reapplyViewportUserAgentOverride(
    guest: Electron.WebContents,
    browserTabId: string,
    url: string
  ): void {
    const mobile = this.viewportUaOverrideMobileByTabId.get(browserTabId)
    if (mobile === undefined) {
      return
    }
    // Why: no queue needed — debugger.sendCommand dispatches in call order over one channel, so the
    // later-issued write wins. What matters is that both writers resolve the SAME host, which they
    // now do via the navigation target rather than the stale committed URL.
    void this.sendViewportUserAgentOverride(guest, mobile, url).catch(() => {})
  }

  protected async sendViewportUserAgentOverride(
    guest: Electron.WebContents,
    mobile: boolean,
    url?: string,
    baseUserAgent?: string
  ): Promise<void> {
    if (guest.isDestroyed() || !guest.debugger.isAttached()) {
      return
    }
    await guest.debugger.sendCommand(
      'Emulation.setUserAgentOverride',
      buildViewportUserAgentOverride({
        url: url ?? this.resolveTabNavigationUrl(guest),
        mobile,
        // Why: the session UA is the profile's stable base identity. guest.getUserAgent() is not:
        // applyGoogleAuthUserAgent leaves it pinned to the Firefox auth UA once a guest switches to
        // the CDP override, so reading it back here would republish that identity on ordinary hosts.
        baseUserAgent: cleanElectronUserAgent(baseUserAgent ?? guest.session.getUserAgent())
      })
    )
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
