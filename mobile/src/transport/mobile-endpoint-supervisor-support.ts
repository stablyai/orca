import { RelayOuterError } from './mobile-relay-e2ee-link'
import { MobileE2EEAuthenticationError } from './mobile-e2ee-v2-physical-channel'
import type { HostProfile } from './types'
import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import { relayWebSocketUrl } from './mobile-access-route-order'

export function isDirectorResolutionFailure(error: Error): boolean {
  return (
    !(error instanceof MobileE2EEAuthenticationError) &&
    (!(error instanceof RelayOuterError) || [4409, 4503, 1006].includes(error.code))
  )
}

export async function persistRelayHost(
  host: HostProfile,
  relay: MobileRelayEndpoint,
  saveHost: (host: HostProfile) => Promise<void>
): Promise<HostProfile> {
  const endpoints = [
    ...(host.endpoints ?? [{ id: 'direct-primary', kind: 'lan' as const, url: host.endpoint }])
  ]
  const relayIndex = endpoints.findIndex(({ kind }) => kind === 'relay')
  const nextRelay = { id: 'relay-primary', kind: 'relay' as const, url: relayWebSocketUrl(relay) }
  if (relayIndex >= 0) {
    endpoints[relayIndex] = nextRelay
  } else {
    endpoints.push(nextRelay)
  }
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

export async function withEndpointRouteDeadline<T>(args: {
  promise: Promise<T>
  timeoutMs: number
  setTimer: typeof setTimeout
  clearTimer: typeof clearTimeout
}): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      args.promise,
      new Promise<never>((_resolve, reject) => {
        timer = args.setTimer(
          () => reject(new Error('ordered route operation timed out')),
          args.timeoutMs
        )
      })
    ])
  } finally {
    if (timer) {
      args.clearTimer(timer)
    }
  }
}
