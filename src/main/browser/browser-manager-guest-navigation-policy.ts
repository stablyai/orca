import {
  normalizeBrowserNavigationUrl,
  toSecureCertificateEndpoint
} from '../../shared/browser-url'
import { isChromiumInternalErrorUrl } from './browser-manager-types'
import { BrowserManagerGuestPopupPolicy } from './browser-manager-guest-popup-policy'

export abstract class BrowserManagerGuestNavigationPolicy extends BrowserManagerGuestPopupPolicy {
  protected installGuestNavigationPolicy(guest: Electron.WebContents): () => void {
    const navigationGuard = (event: Electron.Event, url: string): boolean => {
      // Why: Turnstile loads challenge resources via blob:; blocking them trips error 600010. Allow only http(s) blobs, not opaque ones.
      if (url.startsWith('blob:https://') || url.startsWith('blob:http://')) {
        return true
      }
      // Why: initial file:// attach is allowed for user-opened previews, but block later file:// redirects so remote pages can't probe the FS.
      if (url.startsWith('file:')) {
        event.preventDefault()
        return false
      }
      if (!normalizeBrowserNavigationUrl(url)) {
        // Why: will-attach-webview only validates the initial src; keep enforcing the allowlist on later navs.
        event.preventDefault()
        return false
      }
      return true
    }

    const willRedirectHandler = (
      event: Electron.Event,
      url: string,
      _isInPlace: boolean,
      isMainFrame: boolean
    ): void => {
      if (!navigationGuard(event, url) || !isMainFrame || isChromiumInternalErrorUrl(url)) {
        return
      }
      this.updatePendingNavigationForRedirect(guest.id, url)
      this.applyGoogleAuthUserAgent(guest, url, { duringRedirect: true })
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
      // Why: a nav that never committed must not leave its target standing as the tab's host.
      const failedNavigationWasCurrent = this.failPendingNavigation(guest.id, validatedURL)
      if (failedNavigationWasCurrent) {
        // The attempted host never committed, so restore every UA layer to the document that remains.
        this.applyGoogleAuthUserAgent(guest, guest.getURL())
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
        // Why: this cancellation carries the existing cert warning; don't overwrite it with ERR_ABORTED copy.
        return
      }
      if (errorCode === -3) {
        // Why: an aborted nav never committed; restore the error did-start-navigation cleared so it isn't lost.
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
      _isInPlace: boolean,
      isMainFrame: boolean
    ): void => {
      if (!isMainFrame || isChromiumInternalErrorUrl(url)) {
        return
      }
      // Why: getURL() still reports the previous committed URL until this navigation commits, so
      // every UA writer must read the in-flight target or they disagree about the tab's host.
      this.startPendingNavigation(guest.id, url)
      this.applyGoogleAuthUserAgent(guest, url)
      this.certificateTrustController?.onMainFrameNavigationStarted(guest.id)
      // Why: a pre-registration failure belongs only to its own nav; a replacement nav must not replay it.
      this.pendingLoadFailuresByGuestId.delete(guest.id)
      const activeError = this.loadErrorsByGuestId.get(guest.id)
      if (activeError === undefined) {
        // Why: no error to hide; drop any stale stash so a later abort can't resurrect an old failure.
        this.clearedLoadErrorsByGuestId.delete(guest.id)
        return
      }
      this.clearedLoadErrorsByGuestId.set(guest.id, activeError)
      this.loadErrorsByGuestId.delete(guest.id)
      this.notifyBrowserGuestStateChanged(guest.id)
    }

    const didNavigateHandler = (_event: Electron.Event, url: string): void => {
      // Why: once committed, getURL() reports this url, so the pending target is redundant.
      this.pendingNavigationByGuestId.delete(guest.id)
      // Why: a committed nav makes the did-start-navigation stash obsolete; drop it so a later ERR_ABORTED can't restore an error over it.
      this.clearedLoadErrorsByGuestId.delete(guest.id)
      this.certificateTrustController?.onMainFrameNavigationCommitted(guest.id, url)
    }

    guest.on('will-navigate', navigationGuard)
    guest.on('will-redirect', willRedirectHandler)
    guest.on('did-start-navigation', didStartNavigationHandler)
    guest.on('did-navigate', didNavigateHandler)
    guest.on('did-fail-load', didFailLoadHandler)
    const handleDestroyed = (): void => {
      // Why: guests can die before renderer registration, else attach-time closures leak until shutdown.
      this.cleanupGuestPolicyAttachment(guest.id)
    }
    guest.on('destroyed', handleDestroyed)

    return () => {
      try {
        guest.off('destroyed', handleDestroyed)
      } catch {
        // guest may already be destroyed
      }
      if (!guest.isDestroyed()) {
        guest.off('will-navigate', navigationGuard)
        guest.off('will-redirect', willRedirectHandler)
        guest.off('did-start-navigation', didStartNavigationHandler)
        guest.off('did-navigate', didNavigateHandler)
        guest.off('did-fail-load', didFailLoadHandler)
      }
    }
  }
}
