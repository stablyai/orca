import { app, type BrowserWindow } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const requireNative = createRequire(import.meta.url)

export function configureNotchWindowVisibility(window: BrowserWindow): void {
  if (process.platform !== 'darwin' || window.isDestroyed()) {
    return
  }
  try {
    const addon: unknown = requireNative(
      join(
        app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'out/native'),
        'orca_notch_window.node'
      )
    )
    if (
      typeof addon !== 'object' ||
      addon === null ||
      !('configure' in addon) ||
      typeof addon.configure !== 'function' ||
      addon.configure(window.getNativeWindowHandle()) !== true
    ) {
      throw new Error('Could not configure the native notch window')
    }
  } catch (error) {
    console.warn('[notch] Could not configure native panel visibility and activation:', error)
  }
}
