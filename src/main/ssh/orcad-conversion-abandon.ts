/**
 * Gives a host whose conversion stopped short back to the relay. A destination that was never
 * registered held nothing; a registered one must prove through an abort that it holds nothing,
 * and is unregistered before the fence goes so no later start re-fences the host to it.
 */
import { removeManagedOrcadEnvironment } from '../../shared/runtime-environment-managed-orcad-store'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { closeOrcadManagedTunnel } from './orcad-managed-tunnel'
import {
  abortOrcadMigrationCutover,
  type OrcadMigrationAbortResult,
  type OrcadMigrationCutoverContext,
  type OrcadMigrationDestinationCatalog
} from './orcad-migration-cutover-coordinator'
import { findOrcadMigrationSourceCutoverForTarget } from './orcad-migration-cutover-journal'
import {
  releaseOrcadMigrationFence,
  releaseUndeployedMigrationFence
} from './orcad-migration-source-fence'

export async function abandonOrcadConversion(args: {
  userDataPath: string
  store: OrcadMigrationCutoverContext['store']
  claims: OrcadMigrationCutoverContext['claims']
  targetId: string
  destinationFor: (environment: KnownRuntimeEnvironment) => OrcadMigrationDestinationCatalog
}): Promise<OrcadMigrationAbortResult | 'none'> {
  const cutover = findOrcadMigrationSourceCutoverForTarget(args.userDataPath, args.targetId)
  // A delta move keeps its committed chain; it resolves through the delta flow, never here.
  if (!cutover || cutover.supersedesMigrationId) {
    return 'none'
  }
  const isRegistered = (id: string): boolean =>
    listEnvironments(args.userDataPath).some((entry) => entry.id === id)
  const environment = listEnvironments(args.userDataPath).find(
    (entry) => entry.id === cutover.destinationEnvironmentId
  )
  if (!environment) {
    await releaseUndeployedMigrationFence({ ...args, isDestinationRegistered: isRegistered })
    return 'none'
  }
  const context = { ...args, destination: args.destinationFor(environment) }
  return abortOrcadMigrationCutover(context, cutover.migrationId, async (aborted) => {
    await closeOrcadManagedTunnel(environment.id).catch(() => undefined)
    removeManagedOrcadEnvironment(args.userDataPath, environment.id)
    await releaseOrcadMigrationFence(context, aborted)
  })
}
