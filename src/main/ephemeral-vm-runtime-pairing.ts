import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import { getEphemeralVmRecipeResultPairingCode } from '../shared/ephemeral-vm-recipes'
import { parsePairingCode } from '../shared/pairing'
import { getPreferredPairingOffer } from '../shared/runtime-environments'
import {
  listEnvironments,
  updateEnvironmentFromPairingCode
} from '../shared/runtime-environment-store'

export function synchronizeEphemeralVmRuntimePairing(
  userDataPath: string,
  runtime: EphemeralVmRuntimeRecord
): boolean {
  if (!runtime.runtimeEnvironmentId) {
    return false
  }
  const pairingCode = getEphemeralVmRecipeResultPairingCode(runtime.recipeResult)
  const offer = pairingCode && parsePairingCode(pairingCode)
  if (!offer) {
    throw new Error('Resume result did not include a valid Orca Server pairing code.')
  }
  const environment = listEnvironments(userDataPath).find(
    (entry) => entry.id === runtime.runtimeEnvironmentId
  )
  const current = environment && getPreferredPairingOffer(environment)
  if (
    current &&
    current.endpoint === offer.endpoint &&
    current.deviceToken === offer.deviceToken &&
    current.publicKeyB64 === offer.publicKeyB64 &&
    current.pairedDeviceId === offer.pairedDeviceId
  ) {
    return false
  }
  updateEnvironmentFromPairingCode(userDataPath, runtime.runtimeEnvironmentId, { pairingCode })
  return true
}
