import { readBootIdentity } from '../../../agent-hooks/managed-hook-owner-identity'
import {
  isPreparedLaunchIncarnationGone,
  parsePreparedLaunchGeneration
} from '../../../daemon/prepared-agent-launch-incarnation'
import {
  isPreparedLaunchOperationUnknown,
  type PreparedAgentLaunchDescriptor
} from '../../../../shared/prepared-agent-launch'

/** Evidence one reconciliation pass gathers once per daemon generation and host boot. */
export type DemiseProofPass = {
  generations: Map<string, Promise<boolean>>
  boot?: Promise<string | undefined>
}

// Overlapping passes share an in-flight proof; it is never kept past completion, so a later pass re-proves.
const demiseProofsInFlight = new Map<string, Promise<boolean>>()

/** Retire only on positive owner demise: the exact generation's answer, another boot, or a gone process. */
export async function provesPreparedLaunchOwnerGone(
  error: unknown,
  descriptor: PreparedAgentLaunchDescriptor,
  pass: DemiseProofPass
): Promise<boolean> {
  // That generation's answer is about this one operation, never the whole generation.
  if (isPreparedLaunchOperationUnknown(error)) {
    return true
  }
  const generation = descriptor.daemonGeneration
  const incarnation =
    descriptor.hostScope.hostId === 'local' ? parsePreparedLaunchGeneration(generation) : null
  if (!incarnation) {
    return false
  }
  let proof = pass.generations.get(generation) ?? demiseProofsInFlight.get(generation)
  if (!proof) {
    const created = isPreparedLaunchIncarnationGone(
      incarnation,
      () => (pass.boot ??= readBootIdentity().catch(() => undefined))
    )
      .catch(() => false)
      .finally(() => {
        if (demiseProofsInFlight.get(generation) === created) {
          demiseProofsInFlight.delete(generation)
        }
      })
    demiseProofsInFlight.set(generation, created)
    proof = created
  }
  pass.generations.set(generation, proof)
  return proof
}
