import { Platform } from 'react-native'
import { startPreProfilePairing } from './pre-profile-pairing-coordinator'
import {
  endpointAuthOrigin,
  endpointAuthMutationEpoch,
  normalizeEndpointAuthHeaders,
  type EndpointAuthHeaders
} from './endpoint-auth-headers'
import { writeEndpointAuthHeaders } from './endpoint-auth-headers-store'
import { getHostCredentialWriteRevision } from './host-credential-write-revision'
import type { ConnectOptions } from './rpc-client'
import type { PairingOffer } from './types'

export type PairingEdgeAuthAttempt = {
  readonly result: Promise<{ hostId: string; credentialsSaved: boolean }>
  readonly timedOut: boolean
  retryCredentialSave(): Promise<void>
  dispose(): void
}

export function startPairingWithEdgeAuth(args: {
  offer: PairingOffer
  timeoutMs: number
  headers: EndpointAuthHeaders | null
  isCurrent: () => boolean
  connectOptions?: Pick<ConnectOptions, 'onLog'>
}): PairingEdgeAuthAttempt {
  const endpoint = args.offer.endpoint
  const normalized = normalizeEndpointAuthHeaders(
    Object.entries(args.headers ?? {}).map(([name, value]) => ({ name, value }))
  )
  if (!normalized.ok) {
    throw new Error('Enter valid edge authentication headers.')
  }
  const headers = Object.keys(normalized.headers).length > 0 ? normalized.headers : null
  if (
    headers &&
    (Platform.OS === 'web' ||
      !endpoint.toLowerCase().startsWith('wss://') ||
      !endpointAuthOrigin(endpoint))
  ) {
    throw new Error('Edge authentication requires a native secure WSS connection.')
  }
  let disposed = false
  let hostId: string | null = null
  let revision = 0
  let epoch = 0
  let saving: Promise<void> | null = null
  const active = () => !disposed && !pairing.timedOut && args.isCurrent()
  const assertCurrent = () => {
    if (
      !active() ||
      (hostId !== null &&
        (revision !== getHostCredentialWriteRevision(hostId) ||
          epoch !== endpointAuthMutationEpoch(hostId)))
    ) {
      throw new Error('Pairing cancelled')
    }
  }
  if (disposed || !args.isCurrent()) {
    throw new Error('Pairing cancelled')
  }
  const pairing = startPreProfilePairing({
    offer: { ...args.offer, endpoint },
    timeoutMs: args.timeoutMs,
    connectOptions: { ...args.connectOptions, ...(headers ? { edgeAuthHeaders: headers } : {}) }
  })
  const retryCredentialSave = (): Promise<void> => {
    if (saving) {
      return saving
    }
    const save = async () => {
      assertCurrent()
      if (!hostId || !headers) {
        return
      }
      try {
        const mutation = writeEndpointAuthHeaders(hostId, headers, endpoint, active)
        revision = getHostCredentialWriteRevision(hostId)
        await mutation
        epoch = endpointAuthMutationEpoch(hostId)
        assertCurrent()
      } catch {
        assertCurrent()
        throw new Error('Could not save edge authentication. Retry or configure it from Edit Host.')
      }
    }
    saving = save().finally(() => {
      saving = null
    })
    return saving
  }
  const result = pairing.result.then(async (verified) => {
    assertCurrent()
    hostId = verified.hostId
    revision = getHostCredentialWriteRevision(hostId)
    epoch = endpointAuthMutationEpoch(hostId)
    try {
      await retryCredentialSave()
      return { hostId, credentialsSaved: true }
    } catch {
      assertCurrent()
      return { hostId, credentialsSaved: false }
    }
  })
  return {
    result,
    retryCredentialSave,
    get timedOut() {
      return pairing.timedOut
    },
    dispose() {
      disposed = true
      pairing.dispose()
    }
  }
}
