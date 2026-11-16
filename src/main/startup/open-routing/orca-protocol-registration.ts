import type { App } from 'electron'
import { ZOTZ_PROTOCOL_SCHEME } from '../../../shared/zotz/zotz-app-identity'

/**
 * Registers `zotz://` with Windows, which NSIS installs leave unregistered; macOS reads it from
 * Info.plist and Linux packages from the desktop entry. Only packaged desktop launches register,
 * so dev, test and serve runs never take over the machine's handler.
 */
export function registerOrcaProtocolClient(
  app: Pick<App, 'isPackaged' | 'isDefaultProtocolClient' | 'setAsDefaultProtocolClient'>,
  options: { platform: NodeJS.Platform; desktopLaunch: boolean }
): boolean {
  if (options.platform !== 'win32' || !app.isPackaged || !options.desktopLaunch) {
    return false
  }
  if (app.isDefaultProtocolClient(ZOTZ_PROTOCOL_SCHEME)) {
    return false
  }
  try {
    return app.setAsDefaultProtocolClient(ZOTZ_PROTOCOL_SCHEME)
  } catch (error) {
    console.warn('[protocol] Failed to register zotz:// links:', error)
    return false
  }
}
