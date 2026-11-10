import { readPageHostProfile } from '../mobile-web-shell/bridge/page-host-profile'
import type { MobileRelayEndpoint } from '../../../src/shared/remote-runtime/relay/mobile-relay-credential-contract'
import type { HostCatalogEntry, HostProfile } from './host-profile'

// The page gets no device credential or public key; RPC uses the shell’s paired client.
function pageHosts(): HostProfile[] {
  const host = readPageHostProfile()
  return host === null ? [] : [{ ...host, deviceToken: '', publicKeyB64: '' }]
}

export const loadHosts = (): Promise<HostProfile[]> => Promise.resolve(pageHosts())

export const peekHosts = (): HostProfile[] | null => pageHosts()

export const loadHostCatalog = (): Promise<HostCatalogEntry[]> =>
  Promise.resolve(
    pageHosts().map((profile) => ({ ...profile, credentialStatus: 'ready' as const, profile }))
  )

// Pairing belongs to the native shell.
export const savePairedHost = (_host: HostProfile): Promise<void> => Promise.resolve()

/** Relay routing belongs to the native endpoint lifecycle, which the page does not run. */
export const setRelayRouting = (_hostId: string, _relay: MobileRelayEndpoint): Promise<void> =>
  Promise.resolve()

export const removeHost = (_hostId: string): Promise<void> => Promise.resolve()

export function updateHostNameAndEndpoint(
  _hostId: string,
  _updates: { personalName?: string | null; endpoint?: string }
): Promise<void> {
  return Promise.resolve()
}
