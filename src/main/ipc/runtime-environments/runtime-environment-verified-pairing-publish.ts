import type { VerifyAndAddRuntimeEnvironmentResult } from '../../../shared/remote-runtime/pairing/remote-pairing-verification'
import { listEnvironments } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { getRuntimeEnvironmentStatusOwner } from './runtime-environment-request-connections'
import { clearRuntimeEnvironmentManualDisconnect } from './runtime-environment-manual-disconnect'
import { verifyAndAddRuntimeEnvironmentFromPairingCode } from './runtime-environment-pairing-verification'
import { noteRuntimePairingVerified } from '../../cloud-workspaces/cloud-pairing-seam'

type VerifiedPairing = Extract<VerifyAndAddRuntimeEnvironmentResult, { ok: true }>

function savedPairingRevision(userDataPath: string, environmentId: string): number | undefined {
  try {
    return listEnvironments(userDataPath).find((entry) => entry.id === environmentId)
      ?.pairingRevision
  } catch {
    // Pairing is already saved; an unreadable registry delays status until the next probe.
    return undefined
  }
}

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
  // Invalidation may yield to a newer pairing save.
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

/**
 * The verify-and-add IPC: verify the pairing code end to end, save and publish it, then tell Orca
 * Cloud that this code's pairing completed (a grant's read-snapshot signer may re-pin only now).
 */
export async function verifyAddAndPublishPairing(
  userDataPath: string,
  args: { name: string; pairingCode: string; allowLoopback?: boolean },
  invalidateTransport: (environmentId: string) => Promise<void> | void
): Promise<VerifyAndAddRuntimeEnvironmentResult> {
  const result = await verifyAndAddRuntimeEnvironmentFromPairingCode(userDataPath, args)
  if (result.ok) {
    await publishVerifiedPairing(
      userDataPath,
      result,
      result.updatedExisting ? { invalidateTransport } : null
    )
    await noteRuntimePairingVerified(args.pairingCode)
  }
  return result
}
