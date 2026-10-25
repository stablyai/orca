// Read the shell’s init.host instead of an absent web keychain; otherwise routes would show Host not found.
import { readPageHostProfile } from '../mobile-web-shell/bridge/page-host-profile'
import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import type { HostCatalogEntry, HostProfile } from './types'

// The page gets no device credential or public key; RPC uses the shell’s paired client.
function pageHosts(): HostProfile[] {
  const host = readPageHostProfile()
  return host === null ? [] : [{ ...host, deviceToken: '', publicKeyB64: '' }]
}

export const loadHosts = (): Promise<HostProfile[]> => Promise.resolve(pageHosts())

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

// Recency belongs to the native host list, which this page does not show.
export const updateLastConnected = (_hostId: string): Promise<void> => Promise.resolve()

export function updateHostNameAndEndpoint(
  _hostId: string,
  _updates: { personalName?: string | null; endpoint?: string }
): Promise<void> {
  return Promise.resolve()
}

// Last-known descriptors belong to the native host list.
export function updateHostDescriptor(
  _hostId: string,
  _descriptor: { machineName: string | null; platform: NodeJS.Platform | null }
): Promise<void> {
  return Promise.resolve()
}
