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
import {
  INVALID_PAIRING_ENDPOINT_GUIDANCE,
  resolveAdvertisedPairingEndpoint
} from '../../main/runtime/pairing-endpoint'
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
  // Why: test provided-ness, not truthiness — an empty override must be rejected
  // as invalid, never silently treated as "no override".
  const endpoint =
    endpointAddress === undefined
      ? null
      : resolveEndpointOverride(args.pairingCode, endpointAddress)
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
  // Why: the resolver reads a blank advertised address as "none given" and falls
  // back to loopback, which would silently downgrade a reachable offer here.
  if (address.trim().length === 0) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Invalid --endpoint "${address}". ${INVALID_PAIRING_ENDPOINT_GUIDANCE}`
    )
  }
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
