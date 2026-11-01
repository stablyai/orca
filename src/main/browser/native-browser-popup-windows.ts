import type { BaseWindow, BrowserWindow, WebContents } from 'electron'
import type { HoldQuitNotice } from '../../shared/mac-hold-quit'

// Window-wide menu and renderer routing must distinguish web popups from Orca renderers.
const nativeBrowserPopupWindows = new WeakSet<BrowserWindow>()
export type NativePopupQuitSurface = {
  window: BaseWindow
  notice: (notice: HoldQuitNotice) => void
}
type NativePopupQuitOwner = Pick<WebContents, 'isDestroyed'>
const popupQuitSurfaces = new WeakMap<NativePopupQuitOwner, NativePopupQuitSurface>()
const popupQuitSurfaceListeners = new Set<() => void>()

export function onNativePopupQuitSurfaceChanged(listener: () => void): () => void {
  popupQuitSurfaceListeners.add(listener)
  return () => {
    popupQuitSurfaceListeners.delete(listener)
  }
}

function notifyQuitSurfaceChanged(): void {
  for (const listener of popupQuitSurfaceListeners) {
    listener()
  }
}

export function registerNativePopupQuitSurface(
  contents: WebContents,
  surface: NativePopupQuitSurface
): () => void {
  popupQuitSurfaces.set(contents, surface)
  notifyQuitSurfaceChanged()
  return () => {
    if (popupQuitSurfaces.get(contents) === surface) {
      popupQuitSurfaces.delete(contents)
      notifyQuitSurfaceChanged()
    }
  }
}

export function getNativePopupQuitSurface(
  contents: NativePopupQuitOwner
): NativePopupQuitSurface | undefined {
  return popupQuitSurfaces.get(contents)
}

export function markNativeBrowserPopupWindow(window: BrowserWindow): void {
  nativeBrowserPopupWindows.add(window)
}

export function isNativeBrowserPopupWindow(window: BrowserWindow | null | undefined): boolean {
  return window != null && nativeBrowserPopupWindows.has(window)
}
