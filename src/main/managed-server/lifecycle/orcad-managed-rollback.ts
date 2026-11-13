import {
  redactRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../../../shared/remote-runtime/host-catalog/runtime-environments'

import type { OrcadManagedRollbackResult } from '../../../shared/orcad-managed-runtime'
import { probeActiveOrcadReadiness } from '../activation/orcad-active-readiness'
import { CURRENT_ORCAD_DAEMON_PROTOCOL } from '../activation/orcad-daemon-protocol-crossing'
import {
  managedOrcadInstallDir,
  managedOrcadSlot,
  resolveLinkedOrcadContext
} from './orcad-managed-runtime-context'

import { readRemoteOrcadBuildHash } from '../install/orcad-remote-build-hash'
import { rollbackOrcad } from '../install/orcad-remote-rollback'
import { collectManagedTerminalCensus } from './orcad-terminal-census-client'
import { updateTerminalCounts } from '../activation/orcad-fenced-stop'
import { findIncompleteManagedOrcadMigration } from './orcad-managed-migration-status'
import { latestOrcadMigrationInto } from '../../persistence/migrating-orcad-catalog/cutover-journals/orcad-migration-rollback-mark'
import { refreshMaintainedOrcadPairing } from './orcad-maintenance-pairing-refresh'

import {
  type LifecycleArgs,
  withManagedOrcadLifecycle,
  followLaunchedServerPort
} from './orcad-managed-lifecycle'

export async function rollbackManagedOrcadEnvironment(
  userDataPath: string,
  args: LifecycleArgs
): Promise<OrcadManagedRollbackResult> {
  return await withManagedOrcadLifecycle(
    userDataPath,
    args.selector,
    async ({ environment, deployment }) => {
      const context = await resolveLinkedOrcadContext(environment, deployment, args.signal)
      const record = context.activationRecord
      const target = record.previous
      if (!target) {
        return {
          outcome: 'refused',
          code: 'orcad_rollback_no_target',
          reason: 'This server has no previous version to roll back to.'
        }
      }
      const crossing = migrationRollbackRefusal(userDataPath, environment, record.activatedAt)
      if (crossing) {
        return crossing
      }
      const slot = managedOrcadSlot(context, deployment.remotePort, args.signal)
      const targetDir = managedOrcadInstallDir(context, target)
      const targetBuildHash = await readRemoteOrcadBuildHash(slot, targetDir)
      const { countFirst, ...recount } = updateTerminalCounts((options) =>
        collectManagedTerminalCensus(userDataPath, environment, record, undefined, options)
      )
      // Recount under lock before rollback stop; this initial census closes no admission.
      const census = await countFirst()
      // Require idle because this client cannot prove the older build's daemon protocol attaches to live terminals.
      if (census.liveSessions !== 0) {
        return {
          outcome: 'refused',
          code:
            census.liveSessions === null
              ? 'orcad_rollback_census_unavailable'
              : 'orcad_rollback_terminals_running',
          reason:
            census.liveSessions === null
              ? 'The server did not answer how many terminals it runs. Retry when it answers.'
              : 'Close the terminals running on this server before rolling it back.'
        }
      }
      const result = await rollbackOrcad({
        ...slot,
        record,
        census,
        ...recount,
        targetBuildHash,
        targetDaemonProtocol: CURRENT_ORCAD_DAEMON_PROTOCOL
      })
      if (result.outcome !== 'rolled-back') {
        return result
      }
      const readiness = await probeActiveOrcadReadiness(
        { ...slot, remoteInstallDir: targetDir },
        { buildHash: targetBuildHash, fullVersion: result.target }
      )
      const updated = await refreshMaintainedOrcadPairing(userDataPath, environment.id, readiness)
      await followLaunchedServerPort(userDataPath, environment.id)
      return {
        outcome: 'rolled-back',
        environment: redactRuntimeEnvironment(updated),
        activeVersion: result.target,
        discarded: result.discarded
      }
    }
  )
}

/** A post-activation migration is absent from the rollback snapshot; restoring it would discard imported state. */
function migrationRollbackRefusal(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  activatedAt: string | null
): OrcadManagedRollbackResult | null {
  if (findIncompleteManagedOrcadMigration(userDataPath, environment.id)) {
    return {
      outcome: 'refused',
      code: 'orcad_rollback_migration_in_progress',
      reason: 'A migration into this server is still running. Finish it before rolling back.'
    }
  }
  const migratedAt = latestOrcadMigrationInto(userDataPath, environment)
  if (migratedAt && (activatedAt === null || Date.parse(activatedAt) < Date.parse(migratedAt))) {
    return {
      outcome: 'refused',
      code: 'orcad_rollback_crosses_migration',
      reason:
        "The previous version's state predates the projects migrated onto this server; " +
        'rolling back would lose them. Deploy forward instead.'
    }
  }
  return null
}
