/**
 * Retiring a migrated SSH target's source state, only after the journal proves the destination
 * committed it. The fenced target itself stays: it now carries the managed server's tunnel.
 *
 * Order: profile rows retired and flushed, then the journal moves to `source-retired`, then the
 * journal compacts away once the server matches it. A crash anywhere repeats idempotent work.
 */
import type { OrcadMigrationSourceCutover } from '../../shared/orcad-migration-source-cutover'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { Store } from '../persistence'
import {
  listOrcadMigrationCutoverChainForTarget,
  listOrcadMigrationSourceCutovers,
  removeOrcadMigrationSourceCutover,
  writeOrcadMigrationSourceCutover
} from './orcad-migration-cutover-journal'
import { environmentMatchesManagedOrcadCutover } from './orcad-managed-migration-status'
import { resolveOrcadMigrationFence } from './orcad-migration-source-fence'

export type OrcadMigrationRetirementStore = Pick<
  Store,
  | 'assertOrcadMigrationSourceRetired'
  | 'flushPendingOrThrowAsync'
  | 'getSshRemotePtyLeases'
  | 'getSshTarget'
  | 'removeSshRemotePtyLease'
  | 'retireOrcadMigrationSourceCatalog'
>

export async function retireOrcadMigrationSource(
  context: {
    userDataPath: string
    store: OrcadMigrationRetirementStore
    /** The registered destination; the journal compacts only once it matches. */
    environment: KnownRuntimeEnvironment | null
    now?: () => Date
    signal?: AbortSignal
  },
  migrationId: string
): Promise<OrcadMigrationSourceCutover | null> {
  const cutover = listOrcadMigrationSourceCutovers(context.userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  if (!cutover) {
    throw new Error('orcad_migration_source_cutover_not_found')
  }
  if (cutover.phase !== 'destination-committed' && cutover.phase !== 'source-retired') {
    // Why: until the destination proves its commit, the source is the only real copy.
    throw new Error('orcad_migration_retire_before_commit')
  }
  let retired = cutover
  if (cutover.phase === 'destination-committed') {
    const target = context.store.getSshTarget(cutover.sshTargetId)
    const fence = target ? resolveOrcadMigrationFence(context.userDataPath, target) : null
    // A delta move's earlier migrations retire under the chain head's fence.
    const chain = target
      ? listOrcadMigrationCutoverChainForTarget(context.userDataPath, target.id)
      : []
    if (
      fence?.state !== 'fenced' ||
      !chain.some((entry) => entry.migrationId === cutover.migrationId)
    ) {
      throw new Error('orcad_migration_source_fence_lost')
    }
    context.store.retireOrcadMigrationSourceCatalog(cutover.manifest)
    retireProvenLeases(context.store, cutover)
    await context.store.flushPendingOrThrowAsync({
      signal: context.signal,
      drainToStableGeneration: false
    })
    context.store.assertOrcadMigrationSourceRetired(cutover.manifest)
    retired = {
      ...cutover,
      phase: 'source-retired',
      updatedAt: (context.now ?? (() => new Date()))().toISOString()
    }
    writeOrcadMigrationSourceCutover(context.userDataPath, retired)
  }
  if (context.environment && environmentMatchesManagedOrcadCutover(context.environment, retired)) {
    removeOrcadMigrationSourceCutover(context.userDataPath, retired.migrationId)
    return null
  }
  return retired
}

/** Leases the fence proved exited name a relay that no longer serves this host. */
function retireProvenLeases(
  store: OrcadMigrationRetirementStore,
  cutover: OrcadMigrationSourceCutover
): void {
  const proven = new Set(cutover.provenPtyIds)
  for (const lease of store.getSshRemotePtyLeases(cutover.sshTargetId)) {
    if (proven.has(lease.ptyId) && (lease.state === 'terminated' || lease.state === 'expired')) {
      store.removeSshRemotePtyLease(cutover.sshTargetId, lease.ptyId)
    }
  }
}
