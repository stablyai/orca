import { webContents } from 'electron'
import type { BrowserViewportOverride } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import {
  getBrowserProcessUserAgentIdentity,
  isBrowserProcessUserAgentInitialized
} from '../../../identity/browser-process-user-agent'
import type { BrowserSessionRequestUserAgentResolver } from '../../../identity/requests/browser-session-ua'
import {
  desktopUserAgentMetadata,
  distinctSiteTabIdentities,
  resolveBrowserTabIdentity
} from '../../../identity/browser-tab-identity'
import type { BrowserTabIdentity } from '../../../identity/browser-tab-identity'
import type {
  CdpUserAgentOverride,
  CdpUserAgentOverrideOperation,
  CdpUserAgentOverrideState
} from './browser-user-agent-override-state'
import { BrowserManagerVisibility } from '../browser-manager-visibility'
import { setBrowserGuestPageUserAgentDemand } from '../../../identity/requests/browser-session-ua-demand'
import { teamsRequestUserAgent } from '../../../identity/browser-site-user-agent'

export abstract class BrowserManagerNavigation extends BrowserManagerVisibility {
  resolveBrowserGuestRequestUserAgent(
    request: Parameters<BrowserSessionRequestUserAgentResolver>[0]
  ): BrowserTabIdentity {
    const processIdentity = getBrowserProcessUserAgentIdentity()
    const pendingNavigation =
      request.webContentsId === undefined
        ? undefined
        : this.pendingNavigationByGuestId.get(request.webContentsId)
    const standingOverride =
      request.webContentsId === undefined
        ? undefined
        : this.standingCdpUserAgentOverride(request.webContentsId)
    // A request carrying a site's pinned UA comes from that site's tab, e.g. a sign-in subresource.
    for (const site of distinctSiteTabIdentities(processIdentity.userAgent)) {
      const siteUserAgent = site.identity.userAgent
      const navigationStaysOnSite =
        !pendingNavigation || site.matchesUrl(pendingNavigation.currentUrl)
      if (request.currentUserAgent === siteUserAgent && navigationStaysOnSite) {
        return site.identity
      }
      if (
        !standingOverride &&
        request.effectiveUserAgent === siteUserAgent &&
        navigationStaysOnSite
      ) {
        return site.identity
      }
      if (standingOverride?.userAgent === siteUserAgent) {
        return site.identity
      }
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
    this.noteUserAgentDemand(guest, url, identity)
    // Mobile identity needs CDP metadata that setUserAgent cannot supply.
    const webContentsUserAgent =
      identity.kind === 'site' ? identity.userAgent : getBrowserProcessUserAgentIdentity().userAgent
    let presentedByWebContents = guest.getUserAgent()
    if (!sameDocument && presentedByWebContents !== webContentsUserAgent) {
      guest.setUserAgent(webContentsUserAgent)
      presentedByWebContents = webContentsUserAgent
    }
    return this.writeTabIdentityOverride(guest, identity, presentedByWebContents)
  }

  protected retargetTabIdentity(guest: Electron.WebContents, url: string): Promise<boolean> {
    const identity = this.resolveGuestTabIdentity(guest, url)
    this.noteUserAgentDemand(guest, url, identity)
    return this.writeTabIdentityOverride(guest, identity, guest.getUserAgent())
  }

  /**
   * Synchronous so the session's header policy listens before this navigation's request. Until
   * the target commits, the current page (or a navigation that turns into a download) still needs
   * its own rewrites.
   */
  private noteUserAgentDemand(
    guest: Electron.WebContents,
    url: string,
    identity: BrowserTabIdentity
  ): void {
    const committed = guest.getURL()
    setBrowserGuestPageUserAgentDemand(
      guest.session,
      guest.id,
      rewritesRequestHeaders(url, identity) ||
        rewritesRequestHeaders(committed, this.resolveGuestTabIdentity(guest, committed))
    )
  }

  // Applying or clearing a mobile preset (CDP detach clears it) changes the page's header demand.
  protected override recordAppliedViewportOverride(
    browserTabId: string,
    guestWebContentsId: number,
    applied: BrowserViewportOverride | null
  ): void {
    super.recordAppliedViewportOverride(browserTabId, guestWebContentsId, applied)
    const guest = webContents.fromId(guestWebContentsId)
    if (guest && !guest.isDestroyed() && isBrowserProcessUserAgentInitialized()) {
      // A navigation still in flight keeps its destination's demand alongside the committed page's.
      const url = this.getInFlightNavigationUrl(guest) ?? guest.getURL()
      this.noteUserAgentDemand(guest, url, this.resolveGuestTabIdentity(guest, url))
    }
  }

  /** At commit: the new page's own demand; the old document's iframes are gone. */
  protected settleUserAgentDemand(guest: Electron.WebContents): void {
    // A commit can fire before startup sets the identity; nothing rewrites yet.
    if (!isBrowserProcessUserAgentInitialized()) {
      return
    }
    const url = guest.getURL()
    setBrowserGuestPageUserAgentDemand(
      guest.session,
      guest.id,
      rewritesRequestHeaders(url, this.resolveGuestTabIdentity(guest, url)),
      'clear'
    )
  }

  protected hasTabIdentityOverrideWork(guest: Electron.WebContents, url: string): boolean {
    return (
      this.resolveTabIdentityOverride(
        guest,
        this.resolveGuestTabIdentity(guest, url),
        guest.getUserAgent()
      ) !== null
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
    const override = this.resolveTabIdentityOverride(guest, identity, presentedByWebContents)
    // Without CDP, leave navigation intact; session hooks still rewrite the request UA.
    return override ? this.writeCdpUserAgentOverride(guest, override) : Promise.resolve(true)
  }

  private resolveTabIdentityOverride(
    guest: Electron.WebContents,
    identity: BrowserTabIdentity,
    presentedByWebContents: string
  ): CdpUserAgentOverride | null {
    const override: CdpUserAgentOverride =
      identity.kind === 'mobile'
        ? { userAgent: identity.userAgent, userAgentMetadata: identity.userAgentMetadata }
        : presentedByWebContents === identity.userAgent
          ? { userAgent: '' }
          : // Temporary override until cross-document navigation can update the WebContents UA.
            { userAgent: identity.userAgent, userAgentMetadata: desktopUserAgentMetadata() }
    if (override.userAgent === '' && !this.standingCdpUserAgentOverride(guest.id)) {
      return null
    }
    return override
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

  /** A same-document or abandoned start stays recorded, so only a loading main frame counts. */
  getInFlightNavigationUrl(guest: Electron.WebContents): string | null {
    return guest.isLoadingMainFrame()
      ? (this.pendingNavigationByGuestId.get(guest.id)?.currentUrl ?? null)
      : null
  }

  // Resolve in-flight targets before getURL(), which still names the outgoing document.
  protected resolveTabNavigationUrl(guest: Electron.WebContents): string {
    return this.pendingNavigationByGuestId.get(guest.id)?.currentUrl ?? guest.getURL()
  }
}

export function rewritesRequestHeaders(url: string, identity: BrowserTabIdentity): boolean {
  const processUserAgent = getBrowserProcessUserAgentIdentity().userAgent
  return (
    identity.kind === 'mobile' ||
    identity.userAgent !== processUserAgent ||
    teamsRequestUserAgent(url, processUserAgent) !== processUserAgent
  )
}
