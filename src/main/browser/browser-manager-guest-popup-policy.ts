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
  buildBrowserIframeClickedLinkRoutingScript,
  type BrowserClickedLinkFrameNames
} from './browser-clicked-link-routing'
import { isNewBrowserTabPopupIntent } from './browser-popup-new-tab-intent'
import { SAFE_POPUP_WINDOW_OPTIONS, safeOrigin } from './browser-manager-types'
import type { PopupChildWindowOptions } from './popup-origin-bar-window'
import { BrowserManagerNavigation } from './browser-manager-navigation'

export abstract class BrowserManagerGuestPopupPolicy extends BrowserManagerNavigation {
  protected installGuestPopupPolicy(
    guest: Electron.WebContents,
    routeClickedLinks: boolean
  ): () => void {
    // OAuth child windows keep native link behavior.
    const clickedLinkFrameNames: BrowserClickedLinkFrameNames | null = routeClickedLinks
      ? {
          foreground: `__orca_clicked_link_foreground_${randomUUID()}`,
          background: `__orca_clicked_link_background_${randomUUID()}`
        }
      : null
    let clickedLinkRoutingActive = routeClickedLinks
    const installClickedLinkRouting = (): void => {
      if (!clickedLinkRoutingActive || !clickedLinkFrameNames || guest.isDestroyed()) {
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
                clickedLinkFrameNames.foreground,
                clickedLinkFrameNames.background,
                process.platform === 'darwin'
              )
            }
          ],
          false
        )
        .catch(() => {})
    }
    if (clickedLinkFrameNames) {
      guest.on('dom-ready', installClickedLinkRouting)
    }
    const pendingIframeRoutingInstalls = new Map<Electron.WebFrameMain, () => void>()
    const iframeFrameNamesByFrame = new Map<Electron.WebFrameMain, BrowserClickedLinkFrameNames>()
    const iframeRoutingByFrameName = new Map<
      string,
      { frame: Electron.WebFrameMain; activate: boolean }
    >()
    const clearIframeFrameName = (frame: Electron.WebFrameMain): void => {
      const names = iframeFrameNamesByFrame.get(frame)
      if (!names) {
        return
      }
      iframeFrameNamesByFrame.delete(frame)
      for (const name of [names.foreground, names.background]) {
        iframeRoutingByFrameName.delete(name)
      }
    }
    const installIframeClickedLinkRouting = (frame: Electron.WebFrameMain): void => {
      clearIframeFrameName(frame)
      if (!clickedLinkRoutingActive || frame.isDestroyed()) {
        return
      }
      const foregroundName = `__orca_clicked_link_iframe_foreground_${randomUUID()}`
      const backgroundName = `__orca_clicked_link_iframe_background_${randomUUID()}`
      iframeFrameNamesByFrame.set(frame, {
        foreground: foregroundName,
        background: backgroundName
      })
      iframeRoutingByFrameName.set(foregroundName, { frame, activate: true })
      iframeRoutingByFrameName.set(backgroundName, { frame, activate: false })
      // Why: child-frame tokens live in the page world, so consume after one trusted click and replace before the next.
      void frame
        .executeJavaScript(
          buildBrowserIframeClickedLinkRoutingScript(
            foregroundName,
            backgroundName,
            process.platform === 'darwin'
          ),
          false
        )
        .catch(() => {
          if (iframeFrameNamesByFrame.get(frame)?.foreground === foregroundName) {
            clearIframeFrameName(frame)
          }
        })
    }
    const handleFrameCreated = (
      _event: Electron.Event,
      { frame }: Electron.FrameCreatedDetails
    ): void => {
      if (!clickedLinkFrameNames || !frame || frame.parent === null) {
        return
      }
      for (const knownFrame of iframeFrameNamesByFrame.keys()) {
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
    if (clickedLinkFrameNames) {
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
      const expectedClickedLinkFrameNames = clickedLinkRoutingActive ? clickedLinkFrameNames : null
      const iframeRouting = frameName ? iframeRoutingByFrameName.get(frameName) : undefined
      let clickedLinkActivate: boolean | null = null
      if (expectedClickedLinkFrameNames && frameName === expectedClickedLinkFrameNames.foreground) {
        clickedLinkActivate = true
      } else if (
        expectedClickedLinkFrameNames &&
        frameName === expectedClickedLinkFrameNames.background
      ) {
        clickedLinkActivate = false
      } else if (iframeRouting) {
        clickedLinkActivate = iframeRouting.activate
        clearIframeFrameName(iframeRouting.frame)
        queueMicrotask(() => installIframeClickedLinkRouting(iframeRouting.frame))
      }

      if (clickedLinkActivate !== null) {
        if (
          browserTabId &&
          browserUrl &&
          this.openLinkInOrcaTab(browserTabId, browserUrl, clickedLinkActivate)
        ) {
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
        if (
          this.openLinkInOrcaTab(
            ownerContext.browserTabId,
            externalUrl,
            disposition !== 'background-tab'
          )
        ) {
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
        if (clickedLinkFrameNames) {
          guest.off('dom-ready', installClickedLinkRouting)
          guest.off('frame-created', handleFrameCreated)
          for (const [frame, install] of pendingIframeRoutingInstalls) {
            if (!frame.isDestroyed()) {
              frame.off('dom-ready', install)
            }
          }
          pendingIframeRoutingInstalls.clear()
          iframeFrameNamesByFrame.clear()
          iframeRoutingByFrameName.clear()
        }
      } catch {
        // guest may already be destroyed
      }
    }
  }
}
