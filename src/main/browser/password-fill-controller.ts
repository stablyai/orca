import { BROWSER_PASSWORD_BRIDGE_WORLD_ID } from '../../shared/browser-credential-types'
import {
  buildBrowserPasswordBridgeScript,
  buildBrowserPasswordFillCall
} from '../../shared/browser-password-bridge-script'

export type GuestResolver = (browserTabId: string) => Electron.WebContents | null

export class PasswordFillController {
  private readonly resolveGuest: GuestResolver

  constructor(resolveGuest: GuestResolver) {
    this.resolveGuest = resolveGuest
  }

  async injectBridge(browserTabId: string, token: string, enabled: boolean): Promise<boolean> {
    return this.run(browserTabId, buildBrowserPasswordBridgeScript({ token, enabled }))
  }

  async fill(
    browserTabId: string,
    fieldId: string,
    username: string,
    password: string
  ): Promise<boolean> {
    return this.run(browserTabId, buildBrowserPasswordFillCall(fieldId, username, password))
  }

  private async run(browserTabId: string, code: string): Promise<boolean> {
    const guest = this.resolveGuest(browserTabId)
    if (!guest || guest.isDestroyed()) {
      return false
    }
    try {
      await guest.executeJavaScriptInIsolatedWorld(
        BROWSER_PASSWORD_BRIDGE_WORLD_ID,
        [{ code }],
        false
      )
      return true
    } catch {
      return false
    }
  }
}
