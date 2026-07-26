import { RelayOuterError } from './mobile-relay-e2ee-link'
import { MobileE2EEAuthenticationError } from './mobile-e2ee-v2-physical-channel'
import type { HostProfile } from './types'
import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'

export function isDirectorResolutionFailure(error: Error): boolean {
  return (
    !(error instanceof MobileE2EEAuthenticationError) &&
    (!(error instanceof RelayOuterError) || [4409, 4503, 1006].includes(error.code))
  )
}

export function relayWebSocketUrl(relay: { cellUrl: string; relayHostId: string }): string {
  const url = new URL(relay.cellUrl)
  url.protocol = 'wss:'
  url.pathname = `/v1/connect/${encodeURIComponent(relay.relayHostId)}`
  return url.toString()
}

export async function persistRelayHost(
  host: HostProfile,
  relay: MobileRelayEndpoint,
  saveHost: (host: HostProfile) => Promise<void>
): Promise<HostProfile> {
  const endpoints = [
    ...(host.endpoints ?? [{ id: 'direct-primary', kind: 'lan' as const, url: host.endpoint }])
  ].filter(({ kind }) => kind !== 'relay')
  endpoints.push({ id: 'relay-primary', kind: 'relay', url: relayWebSocketUrl(relay) })
  const updated = { ...host, endpoints, relayHostId: relay.relayHostId, relay }
  await saveHost(updated)
  return updated
}

export function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
