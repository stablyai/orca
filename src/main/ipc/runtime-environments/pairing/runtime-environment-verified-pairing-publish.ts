import type { VerifyAndAddRuntimeEnvironmentResult } from '../../../../shared/remote-runtime/pairing/remote-pairing-verification'
import { withRuntimeEnvironmentStatusOwner } from '../connections/runtime-environment-request-connections'
import { clearRuntimeEnvironmentManualDisconnect } from '../connectivity/runtime-environment-manual-disconnect'

type VerifiedPairing = Extract<VerifyAndAddRuntimeEnvironmentResult, { ok: true }>

/** Retire replaced owners before publishing verified status; reject overlapping saves by pairing revision. */
export async function publishVerifiedPairing(
  userDataPath: string,
  result: VerifiedPairing,
  replaced: { invalidateTransport: (environmentId: string) => Promise<void> | void } | null
): Promise<void> {
  const environmentId = result.environment.id
  // Clear manual disconnect first so invalidation can create a fresh status owner.
  clearRuntimeEnvironmentManualDisconnect(environmentId)
  await replaced?.invalidateTransport(environmentId)
  await withRuntimeEnvironmentStatusOwner(userDataPath, environmentId, (environment, owner) => {
    if (environment.pairingRevision !== result.environment.pairingRevision) {
      return
    }
    owner.acceptVerified({
      id: 'status.get',
      ok: true,
      result: result.runtimeStatus,
      _meta: { runtimeId: result.runtimeStatus.runtimeId }
    })
  }).catch(() => {
    /* A removed or unreadable registry delays status until the next probe. */
  })
}
