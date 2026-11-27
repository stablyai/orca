import { BrowserExtensionApiError } from '../api-runtime/browser-extension-namespace-registry'

// Startup installs the registry lookup; extension modules sit inside the registry's import graph.
let isProfilePresent: ((profileId: string) => boolean) | null = null

export function setBrowserExtensionProfilePresence(probe: (profileId: string) => boolean): void {
  isProfilePresent = probe
}

/** After a wait: a profile deleted meanwhile would mount the extension's tab in a retired partition. */
export function assertBrowserExtensionProfilePresent(profileId: string): void {
  if (isProfilePresent && !isProfilePresent(profileId)) {
    throw new BrowserExtensionApiError('This browser profile was deleted')
  }
}
