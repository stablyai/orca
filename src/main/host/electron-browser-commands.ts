import { RuntimeBrowserCommands } from '../runtime/browser/browser-commands'
import { setRuntimeBrowserCommandsFactory } from '../runtime/runtime-browser-commands-factory'
import { setBrowserHostClientProfileResolver } from '../runtime/browser-host/browser-host-client-profile-metadata'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import { setManagedBrowserProfileDeleter } from '../runtime/browser-host/managed-browser-profile-removal'
import { deleteManagedBrowserProfile } from '../browser/browser-managed-session-profiles'

/** Importing this desktop factory loads the Chromium browser cluster. */
export function installElectronBrowserCommands(): void {
  setRuntimeBrowserCommandsFactory((host) => new RuntimeBrowserCommands(host), {
    clientHosting: true
  })
  setBrowserHostClientProfileResolver((browserProfileId) => {
    const profile = browserSessionRegistry.getProfile(browserProfileId)
    return profile ? { id: profile.id, label: profile.label, scope: profile.scope } : undefined
  })
  setManagedBrowserProfileDeleter(deleteManagedBrowserProfile)
}
