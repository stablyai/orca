import { app } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const requireNative = createRequire(import.meta.url)
let configured = false

export function configureMacMenuDeadKeyGuard(): void {
  if (process.platform !== 'darwin' || configured) {
    return
  }
  try {
    const addon: unknown = requireNative(
      join(
        app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'out/native'),
        'orca_menu_dead_key.node'
      )
    )
    if (
      typeof addon !== 'object' ||
      addon === null ||
      !('configure' in addon) ||
      typeof addon.configure !== 'function' ||
      addon.configure() !== true
    ) {
      throw new Error('Unsupported AppKit menu method')
    }
    configured = true
  } catch (error) {
    console.warn('[menu] Could not install macOS dead-key guard:', error)
  }
}
