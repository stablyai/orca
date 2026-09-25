// Web sibling: the page has no keychain and no host list. `expo-secure-store` resolves to `{}` on
// web, so the real module's `loadHosts()` answers with an empty array and every screen that looks
// this host up paints "Host not found" over the host the shell just opened it for. What crosses
// instead is `init.host`: the profile the screens read, without the credential the bridge carries.
import { readPageHostProfile } from '../mobile-web-shell/bridge/page-host-profile'
import type { HostCatalogEntry, HostProfile } from './types'

/**
 * The one host this document is about, or none before `init`.
 *
 * `deviceToken` and `publicKeyB64` are empty because the page holds neither and needs neither: the
 * RPC crosses the bridge over a client the app already paired. A page-side caller that reads one of
 * them is reaching for something this document was deliberately not given.
 */
function pageHosts(): HostProfile[] {
  const host = readPageHostProfile()
  return host === null ? [] : [{ ...host, deviceToken: '', publicKeyB64: '' }]
}

export const loadHosts = (): Promise<HostProfile[]> => Promise.resolve(pageHosts())

export const loadHostCatalog = (): Promise<HostCatalogEntry[]> =>
  Promise.resolve(
    pageHosts().map((profile) => ({ ...profile, credentialStatus: 'ready' as const, profile }))
  )

/** Pairing happened natively before this document existed, and the page never re-does it. */
export const saveHost = (_host: HostProfile): Promise<void> => Promise.resolve()
export const saveExistingHostRelayUpgrade = (_host: HostProfile): Promise<void> => Promise.resolve()
export const removeHost = (_hostId: string): Promise<void> => Promise.resolve()

/** A native write the page drops: recency orders the app's host list, which the page does not show. */
export const updateLastConnected = (_hostId: string): Promise<void> => Promise.resolve()

export function updateHostNameAndEndpoint(
  _hostId: string,
  _updates: { personalName?: string | null; endpoint?: string }
): Promise<void> {
  return Promise.resolve()
}

/** A native write the page drops: last-known descriptors belong to the app's own host list. */
export function updateHostDescriptor(
  _hostId: string,
  _descriptor: { machineName: string | null; platform: NodeJS.Platform | null }
): Promise<void> {
  return Promise.resolve()
}
