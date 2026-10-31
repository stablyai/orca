import { BrowserWindow, webContents, type WebContents } from 'electron'
import {
  getNativePopupQuitSurface,
  type NativePopupQuitSurface
} from '../browser/native-browser-popup-windows'

export function getDesktopHoldQuitInspectee(contents: WebContents): WebContents | undefined {
  return webContents
    .getAllWebContents()
    .find((candidate) => !candidate.isDestroyed() && candidate.devToolsWebContents === contents)
}

export function getDesktopHoldQuitSurface(
  contents: WebContents
): (NativePopupQuitSurface & { renderer?: WebContents }) | null {
  if (contents.isDestroyed()) {
    return null
  }
  const owner = getDesktopHoldQuitInspectee(contents) ?? contents
  const popup = getNativePopupQuitSurface(owner)
  if (popup) {
    return popup.window.isDestroyed() ? null : popup
  }
  const host = owner.hostWebContents ?? owner
  if (host.isDestroyed()) {
    return null
  }
  const window = BrowserWindow.fromWebContents(host)
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return null
  }
  const renderer = window.webContents
  return {
    window,
    renderer,
    notice: (notice) => {
      if (!renderer.isDestroyed()) {
        renderer.send('ui:holdQuitNotice', notice)
      }
    }
  }
}

export function isDesktopHoldQuitSurfaceFocused(contents: WebContents): boolean {
  const surface = getDesktopHoldQuitSurface(contents)
  return Boolean(
    surface &&
    (getDesktopHoldQuitInspectee(contents) ? contents.isFocused() : surface.window.isFocused())
  )
}

export function hasFocusedDesktopHoldQuitSurface(): boolean {
  return webContents.getAllWebContents().some(isDesktopHoldQuitSurfaceFocused)
}
