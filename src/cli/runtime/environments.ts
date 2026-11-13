import {
  addEnvironmentFromPairingCode as addEnvironmentFromPairingCodeInStore,
  removeEnvironment as removeEnvironmentFromStore,
  resolveEnvironment as resolveEnvironmentFromStore,
  resolveEnvironmentPairingOffer as resolveEnvironmentPairingOfferFromStore
} from '../../shared/remote-runtime/host-store/runtime-environment-store'
import {
  RuntimeEnvironmentStoreError,
  type RuntimeEnvironmentStoreErrorCode
} from '../../shared/remote-runtime/host-store/runtime-environment-store-records'
import type {
  KnownRuntimeEnvironment,
  PublicKnownRuntimeEnvironment
} from '../../shared/remote-runtime/host-catalog/runtime-environments'
import type { PairingOffer } from '../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { RuntimeClientError } from './types'

export type EnvironmentAddResult = {
  environment: PublicKnownRuntimeEnvironment
}

export type EnvironmentRemoveResult = {
  removed: PublicKnownRuntimeEnvironment
}

export async function addEnvironmentFromPairingCode(
  userDataPath: string,
  args: { name: string; pairingCode: string; now?: number }
): Promise<KnownRuntimeEnvironment> {
  return await translateStoreError(
    async () => await addEnvironmentFromPairingCodeInStore(userDataPath, args)
  )
}

export async function removeEnvironment(
  userDataPath: string,
  selector: string
): Promise<KnownRuntimeEnvironment> {
  return await translateStoreError(
    async () => await removeEnvironmentFromStore(userDataPath, selector)
  )
}

export async function resolveEnvironment(
  userDataPath: string,
  selector: string
): Promise<KnownRuntimeEnvironment> {
  return await translateStoreError(
    async () => await resolveEnvironmentFromStore(userDataPath, selector)
  )
}

export async function resolveEnvironmentPairingOffer(
  userDataPath: string,
  selector: string
): Promise<PairingOffer> {
  return await translateStoreError(
    async () => await resolveEnvironmentPairingOfferFromStore(userDataPath, selector)
  )
}

async function translateStoreError<TResult>(fn: () => Promise<TResult>): Promise<TResult> {
  try {
    return await fn()
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
