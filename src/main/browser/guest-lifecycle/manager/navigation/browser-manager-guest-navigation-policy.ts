import {
  normalizeBrowserNavigationUrl,
  toSecureCertificateEndpoint
} from '../../../../../shared/browser-url'
import { isChromiumInternalErrorUrl } from './browser-main-frame-navigation'
import { watchDecisionBlockedMainFrames } from '../../../sessions/requests/browser-session-request-decisions'
import {
  BrowserManagerGuestPopupPolicy,
  isLocalFileLinkFromLocalPage
} from '../popups/browser-manager-guest-popup-policy'
import { allowPageUnload } from '../../navigation/browser-guest-unload-policy'
import { initiatingFrameUrl } from '../../prompts/browser-external-app-launch'
import { isSameExtensionNavigation } from '../../../../../shared/browser/extensions/browser-extension-url'
import {
  browserNavigationLeavesFaviconOrigin,
  pickDisplayableFaviconUrl,
  remoteTabFaviconUrl
} from '../../../../../shared/browser/browser-favicon-url'

export abstract class BrowserManagerGuestNavigationPolicy extends BrowserManagerGuestPopupPolicy {
  protected installGuestNavigationPolicy(guest: Electron.WebContents): () => void {
    const navigationGuard = (
      event: Electron.Event<{ initiator?: Electron.WebFrameMain | null }>,
      url: string
    ): boolean => {
      // Challenge resources use HTTP(S) blobs; opaque blobs remain blocked.
      if (url.startsWith('blob:https://') || url.startsWith('blob:http://')) {
        return true
      }
      // Initial file previews are allowed; web navigations and redirects must not reach local files.
      if (url.startsWith('file:')) {
        event.preventDefault()
        return false
      }
      // Why: an extension page (admitted at attach) may move between its own pages, nowhere else.
      if (url.startsWith('chrome-extension:') && isSameExtensionNavigation(guest.getURL(), url)) {
        return true
      }
      if (!normalizeBrowserNavigationUrl(url)) {
        // Initial-src validation does not cover later navigations.
        event.preventDefault()
        this.requestExternalAppLaunch(guest, url, () => initiatingFrameUrl(event.initiator))
        return false
      }
      return true
    }

    const willNavigateHandler = (event: Electron.Event, url: string): void => {
      if (isLocalFileLinkFromLocalPage(guest, url)) {
        return
      }
      navigationGuard(event, url)
    }

    const willRedirectHandler = (
      event: Electron.Event<Electron.WebContentsWillRedirectEventParams>,
      url: string,
      _isInPlace: boolean,
      isMainFrame: boolean
    ): void => {
      if (!navigationGuard(event, url) || !isMainFrame || isChromiumInternalErrorUrl(url)) {
        return
      }
      this.updatePendingNavigationForRedirect(guest.id, url)
      void this.retargetTabIdentity(guest, url)
    }

    const didFailLoadHandler = (
      _event: Electron.Event,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame: boolean
    ): void => {
      if (!isMainFrame) {
        return
      }
      // A failed navigation must not leave its target as the current host.
      const failedNavigationWasCurrent = this.failPendingNavigation(guest.id, validatedURL)
      if (failedNavigationWasCurrent) {
        void this.retargetTabIdentity(guest, guest.getURL())
      }
      const browserPageId = this.tabIdByWebContentsId.get(guest.id)
      const certificateFailure = browserPageId
        ? this.certificateTrustController?.getFailure(browserPageId)
        : null
      if (
        certificateFailure &&
        toSecureCertificateEndpoint(validatedURL || guest.getURL()) ===
          toSecureCertificateEndpoint(certificateFailure.origin)
      ) {
        // Preserve the certificate warning instead of replacing it with ERR_ABORTED.
        return
      }
      if (errorCode === -3) {
        // An abort must restore the error hidden when navigation started.
        const clearedError = this.clearedLoadErrorsByGuestId.get(guest.id)
        if (clearedError !== undefined) {
          this.clearedLoadErrorsByGuestId.delete(guest.id)
          this.loadErrorsByGuestId.set(guest.id, clearedError)
          this.forwardOrQueueGuestLoadFailure(guest.id, clearedError)
          this.notifyBrowserGuestStateChanged(guest.id)
        }
        return
      }
      this.clearedLoadErrorsByGuestId.delete(guest.id)
      const loadError = this.buildLoadError(
        errorCode,
        errorDescription || 'This site could not be reached.',
        validatedURL || guest.getURL() || 'about:blank'
      )
      this.loadErrorsByGuestId.set(guest.id, loadError)
      this.forwardOrQueueGuestLoadFailure(guest.id, loadError)
      this.notifyBrowserGuestStateChanged(guest.id)
    }

    const didStartNavigationHandler = (
      _event: Electron.Event,
      url: string,
      isInPlace: boolean,
      isMainFrame: boolean
    ): void => {
      if (!isMainFrame || isChromiumInternalErrorUrl(url)) {
        return
      }
      // Like the tab strip: a load that fails on the new origin never commits to clear it.
      if (!isInPlace && browserNavigationLeavesFaviconOrigin(guest.getURL(), url)) {
        this.remoteTabFaviconUrlByGuestId.delete(guest.id)
      }
      // getURL() still names the committed document; UA writers need the in-flight target.
      this.startPendingNavigation(guest.id, url)
      void this.presentTabIdentityAtNavigationStart(guest, url, isInPlace)
      this.certificateTrustController?.onMainFrameNavigationStarted(guest.id)
      // Replacement navigation must not replay a previous pre-registration failure.
      this.pendingLoadFailuresByGuestId.delete(guest.id)
      const activeError = this.loadErrorsByGuestId.get(guest.id)
      if (activeError === undefined) {
        // Discard stale errors so a later abort cannot resurrect them.
        this.clearedLoadErrorsByGuestId.delete(guest.id)
        return
      }
      this.clearedLoadErrorsByGuestId.set(guest.id, activeError)
      this.loadErrorsByGuestId.delete(guest.id)
      this.notifyBrowserGuestStateChanged(guest.id)
    }

    let publishedUrl: string | null = null

    const didNavigateHandler = (_event: Electron.Event, url: string): void => {
      // A redirect can still land on another origin.
      if (browserNavigationLeavesFaviconOrigin(publishedUrl, url)) {
        this.remoteTabFaviconUrlByGuestId.delete(guest.id)
      }
      publishedUrl = guest.getURL()
      this.pendingNavigationByGuestId.delete(guest.id)
      // Committing makes the hidden error obsolete; a later abort must not restore it.
      this.clearedLoadErrorsByGuestId.delete(guest.id)
      this.certificateTrustController?.onMainFrameNavigationCommitted(guest.id, url)
      this.siteDisplayController?.onMainFrameNavigationCommitted(guest.id)
      // Offscreen pages have no renderer to publish their committed URL.
      this.notifyBrowserGuestStateChanged(guest.id)
    }

    const didNavigateInPageHandler = (
      _event: Electron.Event,
      _url: string,
      isMainFrame: boolean
    ): void => {
      if (!isMainFrame) {
        return
      }
      const address = guest.getURL()
      // replaceState reports here even when the address stays the same.
      if (address !== publishedUrl) {
        publishedUrl = address
        this.notifyBrowserGuestStateChanged(guest.id)
      }
    }

    // Renderer webviews keep their own icon. An offscreen page's icon arriving publishes; later
    // swaps (animated or status icons) ride the page's next publish instead of one per frame.
    const faviconUpdatedHandler = (_event: Electron.Event, favicons: string[]): void => {
      if (!this.offscreenGuestIds.has(guest.id)) {
        return
      }
      const next = remoteTabFaviconUrl(pickDisplayableFaviconUrl(favicons))
      const hadIcon = this.remoteTabFaviconUrlByGuestId.has(guest.id)
      if (next) {
        this.remoteTabFaviconUrlByGuestId.set(guest.id, next)
      } else {
        this.remoteTabFaviconUrlByGuestId.delete(guest.id)
      }
      if (next && !hadIcon) {
        this.notifyBrowserGuestStateChanged(guest.id)
      }
    }

    guest.on('will-navigate', willNavigateHandler)
    guest.on('will-redirect', willRedirectHandler)
    guest.on('did-start-navigation', didStartNavigationHandler)
    guest.on('did-navigate', didNavigateHandler)
    guest.on('did-navigate-in-page', didNavigateInPageHandler)
    guest.on('page-favicon-updated', faviconUpdatedHandler)
    guest.on('did-fail-load', didFailLoadHandler)
    // Why emit: an extension-blocked guest main frame commits no error page, so Electron reports
    // nothing; every did-fail-load reader (this policy, the pane, webNavigation) needs the failure.
    const stopWatchingBlockedMainFrames = watchDecisionBlockedMainFrames(guest.id, (url) => {
      const { processId, routingId } = guest.mainFrame
      guest.emit('did-fail-load', {}, -20, 'ERR_BLOCKED_BY_CLIENT', url, true, processId, routingId)
    })
    guest.on('will-prevent-unload', allowPageUnload)
    const handleDestroyed = (): void => {
      const browserTabId = this.tabIdByWebContentsId.get(guest.id)
      // Primary guests also own per-page callbacks that capture their WebContents.
      if (browserTabId && this.webContentsIdByTabId.get(browserTabId) === guest.id) {
        this.unregisterGuest(browserTabId, 'guest-destroyed')
        return
      }
      this.cleanupGuestPolicyAttachment(guest.id)
    }
    guest.on('destroyed', handleDestroyed)

    return () => {
      stopWatchingBlockedMainFrames()
      try {
        guest.off('destroyed', handleDestroyed)
      } catch {
        // guest may already be destroyed
      }
      if (!guest.isDestroyed()) {
        guest.off('will-navigate', willNavigateHandler)
        guest.off('will-redirect', willRedirectHandler)
        guest.off('did-start-navigation', didStartNavigationHandler)
        guest.off('did-navigate', didNavigateHandler)
        guest.off('did-navigate-in-page', didNavigateInPageHandler)
        guest.off('page-favicon-updated', faviconUpdatedHandler)
        guest.off('did-fail-load', didFailLoadHandler)
        guest.off('will-prevent-unload', allowPageUnload)
      }
    }
  }
}
