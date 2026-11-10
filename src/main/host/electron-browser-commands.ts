import { desktopBrowserExtensions } from '../browser/extensions/browser-extension-commands'
import { RuntimeBrowserCommands } from '../runtime/browser/commands/browser-commands'
import { setRuntimeBrowserCommandsFactory } from '../runtime/browser/installation/runtime-browser-commands-factory'
import { setBrowserHostClientProfileResolver } from '../runtime/browser-host/profiles/browser-host-client-profile-metadata'
import { browserSessionRegistry } from '../browser/sessions/profiles/browser-session-registry'
import { setManagedBrowserProfileDeleter } from '../runtime/browser-host/profiles/managed-browser-profile-removal'
import { deleteManagedBrowserProfile } from '../browser/sessions/profiles/browser-managed-session-profiles'

/** Importing this desktop factory loads the Chromium browser cluster. */
export function installElectronBrowserCommands(): void {
  setRuntimeBrowserCommandsFactory((host) => new RuntimeBrowserCommands(host), {
    supportsGoogleCookieClear: () => true,
    clientHosting: true,
    extensions: desktopBrowserExtensions
  })
  setBrowserHostClientProfileResolver((browserProfileId) => {
    const profile = browserSessionRegistry.getProfile(browserProfileId)
    return profile ? { id: profile.id, label: profile.label, scope: profile.scope } : undefined
  })
  setManagedBrowserProfileDeleter(deleteManagedBrowserProfile)
}
