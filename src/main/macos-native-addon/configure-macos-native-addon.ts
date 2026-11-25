import { app } from 'electron'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const requireNative = createRequire(import.meta.url)

/** Loads a macOS native N-API addon guard from resources or out/native and calls its idempotent `configure()` hook. */
export function configureMacNativeAddon(
  addonFilename: string,
  warnMessage: string,
  unsupportedMessage: string
): boolean {
  if (process.platform !== 'darwin') {
    return false
  }
  try {
    const addon: unknown = requireNative(
      join(
        app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'out/native'),
        addonFilename
      )
    )
    if (
      typeof addon !== 'object' ||
      addon === null ||
      !('configure' in addon) ||
      typeof addon.configure !== 'function' ||
      addon.configure() !== true
    ) {
      throw new Error(unsupportedMessage)
    }
    return true
  } catch (error) {
    console.warn(warnMessage, error)
    return false
  }
}
