import {
  addEnvironmentFromPairingCode as addEnvironmentFromPairingCodeInStore,
  getEnvironmentStorePath,
  listEnvironments,
  markEnvironmentUsed as markEnvironmentUsedInStore,
  removeEnvironment as removeEnvironmentFromStore,
  resolveEnvironment as resolveEnvironmentFromStore,
  resolveEnvironmentPairingOffer as resolveEnvironmentPairingOfferFromStore,
  RuntimeEnvironmentStoreError,
  type RuntimeEnvironmentStoreErrorCode
} from '../../shared/runtime-environment-store'
import type {
  KnownRuntimeEnvironment,
  PublicKnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { parsePairingCode, type PairingOffer } from '../../shared/pairing'
import { resolveAdvertisedPairingEndpoint } from '../../main/runtime/pairing-endpoint'
import { RuntimeClientError } from './types'

export type EnvironmentAddResult = {
  environment: PublicKnownRuntimeEnvironment
}

export type EnvironmentListResult = {
  environments: PublicKnownRuntimeEnvironment[]
}

export type EnvironmentRemoveResult = {
  removed: PublicKnownRuntimeEnvironment
}

export { getEnvironmentStorePath, listEnvironments }

export function addEnvironmentFromPairingCode(
  userDataPath: string,
  args: { name: string; pairingCode: string; now?: number; endpointAddress?: string }
): KnownRuntimeEnvironment {
  const { endpointAddress, ...rest } = args
  const endpoint = endpointAddress
    ? resolveEndpointOverride(args.pairingCode, endpointAddress)
    : null
  return translateStoreError(() =>
    addEnvironmentFromPairingCodeInStore(userDataPath, {
      ...rest,
      ...(endpoint ? { endpoint } : {})
    })
  )
}

// Why: reuse the host's advertise grammar so --endpoint accepts the same hosts,
// host:port, and ws(s):// forms the "Share this Orca server" address field does.
function resolveEndpointOverride(pairingCode: string, address: string): string {
  const offer = parsePairingCode(pairingCode)
  if (!offer) {
    throw new RuntimeClientError(
      'invalid_argument',
      'Invalid pairing code. Expected an orca://pair?... URL or bare pairing payload.'
    )
  }
  const resolved = resolveAdvertisedPairingEndpoint(offer.endpoint, address)
  if (!resolved.ok) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid --endpoint "${address}". ${resolved.guidance}`
    )
  }
  return resolved.endpoint
}

export function removeEnvironment(userDataPath: string, selector: string): KnownRuntimeEnvironment {
  return translateStoreError(() => removeEnvironmentFromStore(userDataPath, selector))
}

export function resolveEnvironment(
  userDataPath: string,
  selector: string
): KnownRuntimeEnvironment {
  return translateStoreError(() => resolveEnvironmentFromStore(userDataPath, selector))
}

export function resolveEnvironmentPairingOffer(
  userDataPath: string,
  selector: string
): PairingOffer {
  return translateStoreError(() => resolveEnvironmentPairingOfferFromStore(userDataPath, selector))
}

export function markEnvironmentUsed(
  userDataPath: string,
  selector: string,
  args: { runtimeId?: string | null; now?: number } = {}
): void {
  translateStoreError(() => markEnvironmentUsedInStore(userDataPath, selector, args))
}

function translateStoreError<TResult>(fn: () => TResult): TResult {
  try {
    return fn()
  } catch (error) {
    if (error instanceof RuntimeEnvironmentStoreError) {
      throw new RuntimeClientError(toRuntimeClientErrorCode(error.code), error.message)
    }
    throw error
  }
}

function toRuntimeClientErrorCode(
  code: RuntimeEnvironmentStoreErrorCode
): 'invalid_argument' | 'runtime_error' {
  return code
}
