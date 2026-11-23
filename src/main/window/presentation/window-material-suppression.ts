import { app, type BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  isBlurredWindowMaterial,
  type WindowMaterial
} from '../../../shared/app-lifecycle/windows/window-material'
import { MAC_BLUR_VIBRANCY } from './window-material-options'

type FrostedGlassAddon = { setBackdrop: (windowHandle: Buffer, visible: boolean) => boolean }
type MaterialWindow = Pick<BrowserWindow, 'getNativeWindowHandle' | 'isDestroyed' | 'setVibrancy'>

const requireNative = createRequire(import.meta.url)
const createdMaterials = new WeakMap<MaterialWindow, WindowMaterial>()
const nativeGlassWindows = new WeakMap<MaterialWindow, FrostedGlassAddon>()

function isFrostedGlassAddon(addon: unknown): addon is FrostedGlassAddon {
  return (
    typeof addon === 'object' &&
    addon !== null &&
    'setBackdrop' in addon &&
    typeof addon.setBackdrop === 'function'
  )
}

function loadFrostedGlass(): FrostedGlassAddon | undefined {
  try {
    const resourcesDir = app.isPackaged
      ? process.resourcesPath
      : join(app.getAppPath(), 'out/native')
    const addon: unknown = requireNative(join(resourcesDir, 'orca_frosted_glass.node'))
    if (!isFrostedGlassAddon(addon)) {
      throw new Error('Unexpected Frosted Glass addon exports')
    }
    return addon
  } catch (error) {
    console.warn('[window] Could not load Frosted Glass:', error)
    return undefined
  }
}

export function resolveAvailableWindowMaterial(material: WindowMaterial): WindowMaterial {
  return material === 'frosted' && !loadFrostedGlass() ? 'blur' : material
}

function setFrostedBackdrop(
  window: MaterialWindow,
  addon: FrostedGlassAddon,
  visible: boolean
): boolean {
  try {
    return addon.setBackdrop(window.getNativeWindowHandle(), visible)
  } catch (error) {
    console.warn('[window] Could not set Frosted Glass backdrop:', error)
    return false
  }
}

export function rememberWindowMaterial(window: MaterialWindow, material: WindowMaterial): void {
  createdMaterials.set(window, material)
  if (process.platform !== 'darwin' || material !== 'frosted') {
    return
  }

  const addon = loadFrostedGlass()
  if (addon) {
    window.setVibrancy(null)
    if (setFrostedBackdrop(window, addon, true)) {
      nativeGlassWindows.set(window, addon)
      return
    }
  }
  createdMaterials.set(window, 'blur')
  window.setVibrancy(MAC_BLUR_VIBRANCY)
}

/** Drops macOS blur while a theme image covers it (#8482); other platforms keep their material. */
export function setWindowMaterialSuppressed(
  window: MaterialWindow,
  suppressed: boolean
): WindowMaterial | undefined {
  const material = createdMaterials.get(window)
  if (process.platform !== 'darwin' || !isBlurredWindowMaterial(material) || window.isDestroyed()) {
    return
  }
  const nativeGlass = nativeGlassWindows.get(window)
  if (nativeGlass && setFrostedBackdrop(window, nativeGlass, !suppressed)) {
    return material
  }
  nativeGlassWindows.delete(window)
  createdMaterials.set(window, 'blur')
  window.setVibrancy(suppressed ? null : MAC_BLUR_VIBRANCY)
  return 'blur'
}
