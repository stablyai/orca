import { app, type BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  isBlurredWindowMaterial,
  type WindowMaterial
} from '../../../shared/app-lifecycle/windows/window-material'
import { MAC_BLUR_VIBRANCY } from './window-material-options'

type FrostedGlassAddon = { setBackdrop: (windowHandle: Buffer, visible: boolean) => boolean }

const requireNative = createRequire(import.meta.url)
const createdMaterials = new WeakMap<BrowserWindow, WindowMaterial>()
const nativeGlassWindows = new WeakMap<BrowserWindow, FrostedGlassAddon>()

function isFrostedGlassAddon(addon: unknown): addon is FrostedGlassAddon {
  return (
    typeof addon === 'object' &&
    addon !== null &&
    'setBackdrop' in addon &&
    typeof addon.setBackdrop === 'function'
  )
}

export function rememberWindowMaterial(window: BrowserWindow, material: WindowMaterial): void {
  createdMaterials.set(window, material)
  if (process.platform !== 'darwin' || material !== 'frosted') {
    return
  }

  try {
    const resourcesDir = app.isPackaged
      ? process.resourcesPath
      : join(app.getAppPath(), 'out/native')
    const addon: unknown = requireNative(join(resourcesDir, 'orca_frosted_glass.node'))
    if (!isFrostedGlassAddon(addon)) {
      throw new Error('Unexpected Frosted Glass addon exports')
    }
    window.setVibrancy(null)
    if (addon.setBackdrop(window.getNativeWindowHandle(), true)) {
      nativeGlassWindows.set(window, addon)
      return
    }
  } catch (error) {
    console.warn('[window] Could not apply Frosted Glass:', error)
  }
  window.setVibrancy(MAC_BLUR_VIBRANCY)
}

/** Drops macOS blur while a theme image covers it (#8482); other platforms keep their material. */
export function setWindowMaterialSuppressed(window: BrowserWindow, suppressed: boolean): void {
  if (
    process.platform !== 'darwin' ||
    !isBlurredWindowMaterial(createdMaterials.get(window)) ||
    window.isDestroyed()
  ) {
    return
  }
  const nativeGlass = nativeGlassWindows.get(window)
  if (nativeGlass?.setBackdrop(window.getNativeWindowHandle(), !suppressed)) {
    return
  }
  nativeGlassWindows.delete(window)
  window.setVibrancy(suppressed ? null : MAC_BLUR_VIBRANCY)
}
