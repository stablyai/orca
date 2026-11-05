import type { BrowserWindow } from 'electron'
import type { WindowMaterial } from '../../shared/window-material'
import { MAC_BLUR_VIBRANCY } from './window-material-options'

const createdMaterials = new WeakMap<BrowserWindow, WindowMaterial>()

export function rememberWindowMaterial(window: BrowserWindow, material: WindowMaterial): void {
  createdMaterials.set(window, material)
}

/** Drops macOS vibrancy while an opaque theme image covers it (#8482); `transparent` and Windows acrylic stay. */
export function setWindowMaterialSuppressed(window: BrowserWindow, suppressed: boolean): void {
  if (
    process.platform === 'darwin' &&
    createdMaterials.get(window) === 'blur' &&
    !window.isDestroyed()
  ) {
    window.setVibrancy(suppressed ? null : MAC_BLUR_VIBRANCY)
  }
}
