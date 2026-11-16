import type { VerifyAndAddRuntimeEnvironmentResult } from '../../../../shared/remote-runtime/pairing/remote-pairing-verification'
import { verifyAndAddRuntimeEnvironmentFromPairingCode } from './runtime-environment-pairing-verification'
import { publishVerifiedPairing } from './runtime-environment-verified-pairing-publish'
import { noteRuntimePairingVerified } from '../../../cloud-workspaces/cloud-pairing-seam'

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
