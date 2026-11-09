/** Registered destinations must abort/prove empty, then unregister before fence release so later starts cannot reclaim the host. Never-registered destinations held nothing. */
import { removeManagedOrcadEnvironment } from '../../../../shared/remote-runtime/host-store/runtime-environment-managed-orcad-store'
import { listEnvironments } from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import type { KnownRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { closeOrcadManagedTunnel } from '../../lifecycle/orcad-managed-tunnel'
import {
  abortOrcadMigrationCutover,
  type OrcadMigrationAbortResult,
  type OrcadMigrationCutoverContext,
  type OrcadMigrationDestinationCatalog
} from './orcad-migration-cutover-coordinator'
import { findOrcadMigrationSourceCutoverForTarget } from '../../../persistence/migrating-orcad-catalog/orcad-migration-cutover-journal'
import {
  releaseOrcadMigrationFence,
  releaseUndeployedMigrationFence
} from '../../../ssh/migration-source/orcad-migration-source-fence'

export async function abandonOrcadConversion(args: {
  userDataPath: string
  store: OrcadMigrationCutoverContext['store']
  claims: OrcadMigrationCutoverContext['claims']
  targetId: string
  destinationFor: (environment: KnownRuntimeEnvironment) => OrcadMigrationDestinationCatalog
}): Promise<OrcadMigrationAbortResult | 'none'> {
  const cutover = findOrcadMigrationSourceCutoverForTarget(args.userDataPath, args.targetId)
  // Committed delta chains resolve only through the delta flow.
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
