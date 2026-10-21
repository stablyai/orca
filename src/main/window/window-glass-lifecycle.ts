import type { BrowserWindow } from 'electron'
import type { WindowGlassEnvironment } from './window-glass-policy'
import { resolveWindowGlassPolicy } from './window-glass-policy'

type GlassTheme = {
  on(event: 'updated', listener: () => void): unknown
  removeListener(event: 'updated', listener: () => void): unknown
}

export function installWindowGlassLifecycle(
  window: BrowserWindow,
  theme: GlassTheme,
  environment: () => WindowGlassEnvironment
): void {
  let available = resolveWindowGlassPolicy(environment()).available
  const publish = (): void => {
    if (!window.isDestroyed()) {
      window.webContents.send('window-glass:changed', available)
    }
  }
  const update = (): void => {
    if (window.isDestroyed()) {
      return
    }
    const current = environment()
    const next = resolveWindowGlassPolicy(current)
    // Solid first on fallback: no transparent frame can escape during accessibility changes.
    if (!next.available) {
      window.setBackgroundColor(current.dark ? '#0a0a0a' : '#ffffff')
    }
    if (current.platform === 'darwin') {
      window.setVibrancy(next.available ? 'under-window' : null)
    } else if (current.platform === 'win32' && Number(current.release.split('.')[2]) >= 22621) {
      window.setBackgroundMaterial(next.available ? 'acrylic' : 'none')
    }
    // setBackgroundMaterial('none') resets Electron's fill to white; restore the theme afterward.
    window.setBackgroundColor(next.available ? '#00000000' : current.dark ? '#0a0a0a' : '#ffffff')
    available = next.available
    publish()
  }
  theme.on('updated', update)
  window.webContents.on('did-finish-load', publish)
  window.on('closed', () => {
    theme.removeListener('updated', update)
    window.webContents.removeListener('did-finish-load', publish)
  })
}
