import type { VerifyAndAddRuntimeEnvironmentResult } from '../../../shared/remote-pairing-verification'
import { listEnvironments } from '../../../shared/runtime-environment-store'
import { getRuntimeEnvironmentStatusOwner } from './runtime-environment-request-connections'
import { clearRuntimeEnvironmentManualDisconnect } from './runtime-environment-manual-disconnect'

type VerifiedPairing = Extract<VerifyAndAddRuntimeEnvironmentResult, { ok: true }>

function savedPairingRevision(userDataPath: string, environmentId: string): number | undefined {
  try {
    return listEnvironments(userDataPath).find((entry) => entry.id === environmentId)
      ?.pairingRevision
  } catch {
    // Why: the pairing is already saved; an unreadable store only means its status waits for a probe.
    return undefined
  }
}

/**
 * Publishes the status a pairing was verified with, retiring the replaced pairing's owner first when
 * `replaced`. One choke point so every save-after-verify path fences against an overlapping save.
 */
export async function publishVerifiedPairing(
  userDataPath: string,
  result: VerifiedPairing,
  replaced: { invalidateTransport: (environmentId: string) => Promise<void> | void } | null
): Promise<void> {
  const environmentId = result.environment.id
  // Why before invalidating: a manually disconnected server would not get a fresh owner.
  clearRuntimeEnvironmentManualDisconnect(environmentId)
  // Retires the owner blocked under the replaced pairing; its replacement keys on the new revision.
  await replaced?.invalidateTransport(environmentId)
  // Why: an overlapping save may have replaced this pairing during the await.
  if (savedPairingRevision(userDataPath, environmentId) !== result.environment.pairingRevision) {
    return
  }
  getRuntimeEnvironmentStatusOwner(userDataPath, environmentId).acceptVerified({
    id: 'status.get',
    ok: true,
    result: result.runtimeStatus,
    _meta: { runtimeId: result.runtimeStatus.runtimeId }
  })
}
