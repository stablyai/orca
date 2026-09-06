import { shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { ORCA_BROWSER_BLANK_URL } from '../../shared/constants'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl,
  redactKagiSessionToken
} from '../../shared/browser-url'
import {
  BROWSER_CLICKED_LINK_ROUTING_WORLD_ID,
  buildBrowserClickedLinkRoutingScript,
  buildBrowserIframeClickedLinkRoutingScript
} from './browser-clicked-link-routing'
import { isNewBrowserTabPopupIntent } from './browser-popup-new-tab-intent'
import { SAFE_POPUP_WINDOW_OPTIONS, safeOrigin } from './browser-manager-types'
import type { PopupChildWindowOptions } from './popup-origin-bar-window'
import { BrowserManagerNavigation } from './browser-manager-navigation'

export abstract class BrowserManagerGuestPopupPolicy extends BrowserManagerNavigation {
  protected installGuestPopupPolicy(
    guest: Electron.WebContents,
    clickedLinkFrameName: string | null
  ): () => void {
    let clickedLinkRoutingActive = Boolean(clickedLinkFrameName)
    const installClickedLinkRouting = (): void => {
      if (!clickedLinkRoutingActive || !clickedLinkFrameName || guest.isDestroyed()) {
        return
      }
      // Why: an isolated-world listener labels real anchor clicks without exposing the frame name to page scripts.
      void guest
        .executeJavaScriptInIsolatedWorld(
          BROWSER_CLICKED_LINK_ROUTING_WORLD_ID,
          [
            {
              // Why: mobile emulation spoofs the UA as iOS, so use the real host platform from main for modifier routing.
              code: buildBrowserClickedLinkRoutingScript(
                clickedLinkFrameName,
                process.platform === 'darwin'
              )
            }
          ],
          false
        )
        .catch(() => {})
    }
    if (clickedLinkFrameName) {
      guest.on('dom-ready', installClickedLinkRouting)
    }
    const pendingIframeRoutingInstalls = new Map<Electron.WebFrameMain, () => void>()
    const iframeFrameNameByFrame = new Map<Electron.WebFrameMain, string>()
    const iframeFrameByFrameName = new Map<string, Electron.WebFrameMain>()
    const clearIframeFrameName = (frame: Electron.WebFrameMain): void => {
      const name = iframeFrameNameByFrame.get(frame)
      if (!name) {
        return
      }
      iframeFrameNameByFrame.delete(frame)
      iframeFrameByFrameName.delete(name)
    }
    const installIframeClickedLinkRouting = (frame: Electron.WebFrameMain): void => {
      clearIframeFrameName(frame)
      if (!clickedLinkRoutingActive || frame.isDestroyed()) {
        return
      }
      const name = `__orca_clicked_link_iframe_foreground_${randomUUID()}`
      iframeFrameNameByFrame.set(frame, name)
      iframeFrameByFrameName.set(name, frame)
      // Why: child-frame tokens live in the page world, so consume after one trusted click and replace before the next.
      void frame
        .executeJavaScript(
          buildBrowserIframeClickedLinkRoutingScript(name, process.platform === 'darwin'),
          false
        )
        .catch(() => {
          if (iframeFrameNameByFrame.get(frame) === name) {
            clearIframeFrameName(frame)
          }
        })
    }
    const handleFrameCreated = (
      _event: Electron.Event,
      { frame }: Electron.FrameCreatedDetails
    ): void => {
      if (!clickedLinkFrameName || !frame || frame.parent === null) {
        return
      }
      for (const knownFrame of iframeFrameNameByFrame.keys()) {
        if (knownFrame.isDestroyed()) {
          clearIframeFrameName(knownFrame)
        }
      }
      const installAfterDomReady = (): void => {
        pendingIframeRoutingInstalls.delete(frame)
        installIframeClickedLinkRouting(frame)
      }
      pendingIframeRoutingInstalls.set(frame, installAfterDomReady)
      frame.once('dom-ready', installAfterDomReady)
    }
    if (clickedLinkFrameName) {
      guest.on('frame-created', handleFrameCreated)
    }
    const handleDidCreateWindow = (window: Electron.BrowserWindow): void => {
      // Why: popup descendants inherit the opener's owner context but must not replace its primary registration.
      this.attachGuestPolicies(window.webContents, this.resolvePopupOwnerContext(guest.id))
    }
    guest.on('did-create-window', handleDidCreateWindow)
    guest.setWindowOpenHandler(({ url, frameName, disposition, features }) => {
      const ownerContext = this.resolvePopupOwnerContext(guest.id)
      const browserTabId = ownerContext?.browserTabId ?? null
      const browserUrl = normalizeBrowserNavigationUrl(url)
      const externalUrl = normalizeExternalBrowserUrl(url)
      const expectedClickedLinkFrameName = this.clickedLinkFrameNameByGuestId.get(guest.id)
      const iframeFrame = frameName ? iframeFrameByFrameName.get(frameName) : undefined
      let isClickedLink = Boolean(
        expectedClickedLinkFrameName && frameName === expectedClickedLinkFrameName
      )
      if (!isClickedLink && iframeFrame) {
        isClickedLink = true
        clearIframeFrameName(iframeFrame)
        queueMicrotask(() => installIframeClickedLinkRouting(iframeFrame))
      }

      if (isClickedLink) {
        if (browserTabId && browserUrl && this.openLinkInOrcaTab(browserTabId, browserUrl)) {
          this.forwardOrQueuePopupEvent(guest.id, {
            origin: safeOrigin(browserUrl),
            action: 'opened-in-orca'
          })
        }
        // Why: a recognized gesture must never fall through to a native popup if its renderer vanished mid-click.
        return { action: 'deny' }
      }

      // Why: an unnamed, featureless window.open() is Chromium's own new-tab shape, so an Orca tab is
      // the honest presentation; a floating origin-bar window is not. Opener-dependent shapes are
      // excluded by isNewBrowserTabPopupIntent and still get a real child window below.
      if (
        ownerContext &&
        externalUrl &&
        isNewBrowserTabPopupIntent({ frameName, disposition, features })
      ) {
        // Why: one activation lets a page loop window.open, and each routed tab persists into
        // workspace session state, so it survives the quit that used to clear popup windows.
        if (!this.tryConsumePageInitiatedTab(ownerContext.rootGuestWebContentsId)) {
          this.forwardOrQueuePopupEvent(guest.id, {
            origin: safeOrigin(externalUrl),
            action: 'blocked'
          })
          return { action: 'deny' }
        }
        if (this.openLinkInOrcaTab(ownerContext.browserTabId, externalUrl)) {
          this.forwardOrQueuePopupEvent(guest.id, {
            origin: safeOrigin(externalUrl),
            action: 'opened-in-orca'
          })
        }
        // Why: a recognized new-tab intent must never fall through to a native popup if its renderer vanished mid-open.
        return { action: 'deny' }
      }

      // Why: file URLs are fine for in-pane previews, but must not spawn native child windows targeting local paths.
      const canOpenAsChild = Boolean(externalUrl || browserUrl === ORCA_BROWSER_BLANK_URL)
      if (browserTabId && canOpenAsChild) {
        // Why: OAuth may request size/position, but content must not create deceptive or inescapable native chrome.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: SAFE_POPUP_WINDOW_OPTIONS,
          // Why: default child windows lack an address bar; host in an Orca origin-bar window so the destination is verifiable.
          createWindow: (options: PopupChildWindowOptions) =>
            this.createPopupChildWindowWithOriginBar(guest, url, options)
        }
      } else if (externalUrl) {
        // Why: Kagi target=_blank popup URLs still contain the bearer token; redact before handing to the OS browser.
        void shell.openExternal(redactKagiSessionToken(externalUrl))
        this.forwardOrQueuePopupEvent(guest.id, {
          origin: safeOrigin(externalUrl),
          action: 'opened-external'
        })
      } else {
        // Why: popup URLs can carry auth redirects/one-time tokens; surface only sanitized origin metadata.
        this.forwardOrQueuePopupEvent(guest.id, {
          origin: safeOrigin(url),
          action: 'blocked'
        })
      }
      return { action: 'deny' }
    })

    return () => {
      clickedLinkRoutingActive = false
      try {
        guest.off('did-create-window', handleDidCreateWindow)
        if (clickedLinkFrameName) {
          guest.off('dom-ready', installClickedLinkRouting)
          guest.off('frame-created', handleFrameCreated)
          for (const [frame, install] of pendingIframeRoutingInstalls) {
            if (!frame.isDestroyed()) {
              frame.off('dom-ready', install)
            }
          }
          pendingIframeRoutingInstalls.clear()
          iframeFrameNameByFrame.clear()
          iframeFrameByFrameName.clear()
        }
      } catch {
        // guest may already be destroyed
      }
    }
  }
}
