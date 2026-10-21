import { RuntimeBrowserCommands } from '../runtime/browser/browser-commands'
import { setRuntimeBrowserCommandsFactory } from '../runtime/runtime-browser-commands-factory'
import { setBrowserHostClientProfileResolver } from '../runtime/browser-host/browser-host-client-profile-metadata'
import { browserSessionRegistry } from '../browser/browser-session-registry'

/** The desktop factory. Importing this file is what pulls in the Chromium browser cluster. */
export function installElectronBrowserCommands(): void {
  setRuntimeBrowserCommandsFactory((host) => new RuntimeBrowserCommands(host), {
    clientHosting: true
  })
  setBrowserHostClientProfileResolver((browserProfileId) => {
    const profile = browserSessionRegistry.getProfile(browserProfileId)
    return profile ? { id: profile.id, label: profile.label, scope: profile.scope } : undefined
  })
}
