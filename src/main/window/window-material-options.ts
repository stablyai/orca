import type { BrowserWindowConstructorOptions } from 'electron'
import type { WindowMaterial } from '../../shared/window-material'

type WindowMaterialOptions = Pick<
  BrowserWindowConstructorOptions,
  'backgroundColor' | 'transparent' | 'vibrancy' | 'visualEffectState' | 'backgroundMaterial'
>

const CLEAR = '#00000000'

export const MAC_BLUR_VIBRANCY = 'under-window'

/** Creation-time window options; any opaque fill would paint over the material (#8797). */
export function windowMaterialOptions(
  material: WindowMaterial,
  platform: NodeJS.Platform,
  opaqueBackground: string
): WindowMaterialOptions {
  if (material === 'off') {
    return { backgroundColor: opaqueBackground }
  }
  if (platform === 'darwin') {
    // Why no `transparent` with vibrancy: it suppresses the effect view and forces full-window alpha compositing (#8482).
    // Why active: the default follows focus and turns into a flat gray fill whenever Orca is unfocused.
    return material === 'blur'
      ? { backgroundColor: CLEAR, vibrancy: MAC_BLUR_VIBRANCY, visualEffectState: 'active' }
      : { backgroundColor: CLEAR, transparent: true }
  }
  if (platform === 'win32') {
    return { backgroundColor: CLEAR, backgroundMaterial: 'acrylic' }
  }
  // Linux compositors (KWin, Mutter, Hyprland, picom) blend alpha windows and apply their own blur rules.
  return { backgroundColor: CLEAR, transparent: true }
}
