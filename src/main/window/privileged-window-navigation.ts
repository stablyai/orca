import { shell, type WebContents } from 'electron'
import { is } from '@electron-toolkit/utils'
import { normalizeExternalBrowserUrl } from '../../shared/browser-url'
import {
  AUX_WINDOW_DEFAULT_SIZE,
  isAuxWindowFrameName,
  parseAuxWindowFeatures
} from '../../shared/aux-window'
import { rectHasVisibleAreaOnAnyDisplay } from './window-bounds-validation'

/** Enough of the window must be on-screen that its titlebar stays grabbable. */
const AUX_WINDOW_MIN_VISIBLE_PX = 120

function installDenyByDefaultNavigationPolicy(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    const externalUrl = normalizeExternalBrowserUrl(url)
    if (externalUrl) {
      void shell.openExternal(externalUrl)
    }
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    const externalUrl = normalizeExternalBrowserUrl(url)
    if (externalUrl) {
      void shell.openExternal(externalUrl)
    }
    event.preventDefault()
  })
}

/** Keep remote documents from inheriting an Orca window's privileged preload. */
export function installPrivilegedWindowNavigationPolicy(contents: WebContents): void {
  contents.on('did-create-window', (child, details) => {
    if (details.url === 'about:blank' && isAuxWindowFrameName(details.frameName)) {
      installDenyByDefaultNavigationPolicy(child.webContents)
    }
  })
  contents.setWindowOpenHandler(({ url, frameName, features }) => {
    // Why: about:blank inherits privileged parent webPreferences, including
    // preload. Keep it same-origin for portals and harden its webContents when
    // Electron reports the verified child through did-create-window.
    if (url === 'about:blank' && isAuxWindowFrameName(frameName)) {
      const requested = parseAuxWindowFeatures(features)
      const bounds = {
        width: requested.width ?? AUX_WINDOW_DEFAULT_SIZE.width,
        height: requested.height ?? AUX_WINDOW_DEFAULT_SIZE.height,
        ...(requested.x !== undefined && requested.y !== undefined
          ? { x: requested.x, y: requested.y }
          : {})
      }
      // Why: a restored window must land on a display that still exists — an
      // unplugged monitor would otherwise put it offscreen and unreachable.
      const placeable =
        requested.x !== undefined &&
        requested.y !== undefined &&
        rectHasVisibleAreaOnAnyDisplay(
          { x: requested.x, y: requested.y, width: bounds.width, height: bounds.height },
          AUX_WINDOW_MIN_VISIBLE_PX,
          AUX_WINDOW_MIN_VISIBLE_PX
        )
      const placement = placeable ? bounds : { width: bounds.width, height: bounds.height }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          // Native frame: matches the dashboard pop-out, which deliberately
          // skips the custom titlebar (dashboard-popout-window.ts:169-173).
          ...placement,
          webPreferences: { sandbox: true, contextIsolation: true }
        }
      }
    }
    const externalUrl = normalizeExternalBrowserUrl(url)
    if (externalUrl) {
      void shell.openExternal(externalUrl)
    }
    return { action: 'deny' }
  })

  contents.on('will-navigate', (event, url) => {
    const externalUrl = normalizeExternalBrowserUrl(url)
    if (externalUrl) {
      if (is.dev && process.env.ELECTRON_RENDERER_URL) {
        try {
          const target = new URL(externalUrl)
          const allowed = new URL(process.env.ELECTRON_RENDERER_URL)
          if (target.origin === allowed.origin) {
            return
          }
        } catch {
          // Fall through and block malformed navigation targets.
        }
      }
      void shell.openExternal(externalUrl)
    }
    event.preventDefault()
  })
}
