/**
 * Can this relay-hosted SSH target's state be exported to a managed orcad?
 *
 * Unlike claiming an empty target, export carries the target's repositories, folder
 * workspaces and the dormant state the manifest can represent, so those drain rather than block.
 * What blocks is what cannot move: another owner, live terminal leases, and dependent state the
 * manifest cannot carry. Read-only: building the manifest here exports nothing.
 */
import { isLiveSshPtyLease } from '../../shared/ssh-pty-lease-liveness'
import type { Store } from '../persistence'
import type {
  OrcadMigrationBlocker,
  OrcadMigrationPreflight
} from '../../shared/orcad-migration-preflight'
import {
  createOrcadMigrationManifest,
  type OrcadMigrationExportStore
} from './orcad-migration-manifest-export'
import {
  collectTargetCatalogBlockers,
  resolveOrcadPreflightTarget
} from './ssh-target-orcad-claims'
import { collectUntransferredDependentBlockers } from './ssh-target-orcad-dependents'

export type OrcadMigrationPreflightStore = OrcadMigrationExportStore &
  Pick<
    Store,
    'getSshTarget' | 'getSshRemotePtyLeases' | 'inspectOrcadMigrationUntransferredDependencies'
  >

/** `owner` passes the environment's own fence only when its migration journal is on disk. */
export function preflightOrcadMigrationExport(
  store: OrcadMigrationPreflightStore,
  targetId: string,
  owner?: { environmentId: string; recorded: boolean }
): OrcadMigrationPreflight {
  const resolved = resolveOrcadPreflightTarget(store, targetId, owner)
  if ('result' in resolved) {
    return resolved.result
  }
  const { target } = resolved
  const blockers: OrcadMigrationBlocker[] = [...collectTargetCatalogBlockers(store, target)]
  const terminalLeases = store
    .getSshRemotePtyLeases(targetId)
    .filter(isLiveSshPtyLease)
    .map(({ ptyId, worktreeId, tabId, leafId, state, updatedAt }) => ({
      ptyId,
      worktreeId,
      tabId,
      leafId,
      state,
      updatedAt
    }))
  if (terminalLeases.length > 0) {
    // A relay PTY cannot move to orcad; its work must finish first.
    blockers.push({
      code: 'orcad_migration_direct_ssh_terminal_leases',
      category: 'live-or-unverifiable',
      terminalLeases
    })
  }
  blockers.push(
    ...collectUntransferredDependentBlockers(store, createOrcadMigrationManifest(store, target))
  )
  return {
    targetId,
    targetLabel: target.label,
    claimable: !blockers.some(isBlockingOrcadMigrationBlocker),
    blockers
  }
}

// Exported catalog rows and saved port forwards (which stay with the source) do not block.
export function isBlockingOrcadMigrationBlocker(blocker: OrcadMigrationBlocker): boolean {
  return (
    blocker.category !== 'drainable-static-state' &&
    blocker.code !== 'orcad_migration_saved_port_forwards'
  )
}
