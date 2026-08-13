import { updateEphemeralVmRuntimeStatus } from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import { getEphemeralVmRecipeResultPairingCode } from '../shared/ephemeral-vm-recipes'
import { updateEnvironmentFromPairingCode } from '../shared/runtime-environment-store'

export function resumeEphemeralVmRuntimeEnvironment(args: {
  userDataPath: string
  environmentId: string
  runtime: EphemeralVmRuntimeRecord
  invalidateTransport: (environmentId: string) => void
}): EphemeralVmRuntimeRecord {
  try {
    const pairingCode = getEphemeralVmRecipeResultPairingCode(args.runtime.recipeResult)
    if (!pairingCode) {
      throw new Error('Resume result did not include an Orca Server pairing code.')
    }
    updateEnvironmentFromPairingCode(args.userDataPath, args.environmentId, { pairingCode })
    args.invalidateTransport(args.environmentId)
    return updateEphemeralVmRuntimeStatus(args.userDataPath, args.runtime.id, {
      status: 'running',
      resumeConnectionPending: false
    })
  } catch (error) {
    updateEphemeralVmRuntimeStatus(args.userDataPath, args.runtime.id, {
      status: 'resume_failed',
      resumeConnectionPending: true
    })
    throw error
  }
}
