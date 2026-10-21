/**
 * The one place a managed tunnel build turns "our own server refused our token" into a re-pair.
 * The refusal is proven before this runs: it arrived sealed under the pinned host key, so a
 * foreign server never reaches the repair; it fails the build as a foreign answer instead.
 */
import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { pairingRevisionOf, type ManagedOrcadPairingRepairs } from './orcad-managed-pairing-repair'
import { OrcadManagedPairingRejectedError } from './orcad-managed-tunnel-identity'

export type ManagedOrcadPairingRecovery = {
  resolve: (environmentId: string) => KnownRuntimeEnvironment
  repairs: ManagedOrcadPairingRepairs
  /** Forwards on the new pairing; the refusal already removed the old forward. */
  ensure: (environment: KnownRuntimeEnvironment) => Promise<void>
}

/**
 * Builds once; a refused pairing re-pairs over SSH and forwards once more on the new one. The
 * repair gate decides first whether a build may run: while a failure stands for this pairing,
 * every caller (each refused socket reopen included) gets it without reaching the host.
 */
export async function buildWithPairingRepair(
  recovery: ManagedOrcadPairingRecovery,
  environmentId: string,
  build: (environment: KnownRuntimeEnvironment) => Promise<void>
): Promise<'built' | 'repaired'> {
  const refused = recovery.resolve(environmentId)
  const epoch = recovery.repairs.resetEpoch(environmentId)
  const standing = recovery.repairs.standingFailure(environmentId, pairingRevisionOf(refused))
  if (standing) {
    throw standing
  }
  try {
    await build(refused)
    return 'built'
  } catch (error) {
    if (!(error instanceof OrcadManagedPairingRejectedError)) {
      throw error
    }
    console.warn('[ssh] The managed Orca server refused this desktop; pairing again:', error)
  }
  // Why the refused revision: a repair another caller already landed is joined, not redone.
  const repaired = await recovery.repairs.repair(environmentId, pairingRevisionOf(refused))
  try {
    await recovery.ensure(repaired)
  } catch (error) {
    throw error instanceof OrcadManagedPairingRejectedError
      ? recovery.repairs.recordRefusedAfterRepair(environmentId, pairingRevisionOf(repaired), epoch)
      : error
  }
  return 'repaired'
}
