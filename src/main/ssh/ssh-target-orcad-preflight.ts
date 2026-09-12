import type { Store } from '../persistence'
import { getManagedOrcadOwnerEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
import type {
  OrcadMigrationBlocker,
  OrcadMigrationPreflight,
  OrcadMigrationDependency
} from '../../shared/orcad-migration-preflight'
import { ORCAD_MIGRATION_DEPENDENCY_KINDS } from '../../shared/orcad-migration-preflight'
import { createOrcadMigrationManifest } from './orcad-migration-manifest-export'

export function preflightOrcadRuntimeTarget(
  store: Store,
  targetId: string,
  environmentId?: string
): OrcadMigrationPreflight {
  const target = store.getSshTarget(targetId)
  if (!target) {
    return {
      targetId,
      targetLabel: null,
      claimable: false,
      blockers: [{ code: 'orcad_migration_target_not_found', category: 'registration' }]
    }
  }
  if (getManagedOrcadOwnerEnvironmentId(target.owner) === environmentId) {
    return { targetId, targetLabel: target.label, claimable: true, blockers: [] }
  }

  const blockers: OrcadMigrationBlocker[] = []
  if (target.owner) {
    blockers.push({
      code: 'orcad_migration_target_owned',
      category: 'exclusive-ownership',
      owner: { ...target.owner }
    })
  }
  const repositories = store
    .getRepos()
    .filter((repo) => repo.connectionId === targetId)
    .map(({ id, path, displayName, kind }) => ({ id, path, displayName, kind }))
  if (repositories.length > 0) {
    blockers.push({
      code: 'orcad_migration_direct_ssh_repositories',
      category: 'drainable-static-state',
      repositories
    })
  }
  const folderWorkspaces = store
    .getFolderWorkspaces()
    .filter((workspace) => workspace.connectionId === targetId)
    .map(({ id, name, folderPath }) => ({ id, name, folderPath }))
  if (folderWorkspaces.length > 0) {
    blockers.push({
      code: 'orcad_migration_direct_ssh_folder_workspaces',
      category: 'drainable-static-state',
      folderWorkspaces
    })
  }
  const terminalLeases = store
    .getSshRemotePtyLeases(targetId)
    .filter((lease) => lease.state !== 'terminated' && lease.state !== 'expired')
    .map(({ ptyId, worktreeId, tabId, leafId, state, updatedAt }) => ({
      ptyId,
      worktreeId,
      tabId,
      leafId,
      state,
      updatedAt
    }))
  if (terminalLeases.length > 0) {
    blockers.push({
      code: 'orcad_migration_direct_ssh_terminal_leases',
      category: 'live-or-unverifiable',
      terminalLeases
    })
  }
  if (target.portForwards?.length) {
    blockers.push({
      code: 'orcad_migration_saved_port_forwards',
      category: 'client-owned-state',
      portForwards: target.portForwards.map((portForward) => ({ ...portForward }))
    })
  }
  const manifest = createOrcadMigrationManifest(store, target)
  const census = store.inspectOrcadMigrationSourceDependencies(manifest)
  const dependencies: OrcadMigrationDependency[] = ORCAD_MIGRATION_DEPENDENCY_KINDS.filter(
    (kind) => kind !== 'saved-port-forward' && kind !== 'terminal-lease'
  )
    .filter((kind) => census.counts[kind] > 0)
    .map((kind) => ({ kind, count: census.counts[kind] }))
  if (dependencies.length > 0) {
    blockers.push({
      code: 'orcad_migration_dependent_state',
      category: 'client-owned-state',
      dependencies
    })
  }
  return {
    targetId,
    targetLabel: target.label,
    claimable: blockers.every(
      (entry) =>
        entry.category === 'drainable-static-state' ||
        entry.code === 'orcad_migration_saved_port_forwards'
    ),
    blockers
  }
}

export function orcadMigrationBlockerMessage(
  targetId: string,
  blocker: OrcadMigrationBlocker
): string {
  switch (blocker.code) {
    case 'orcad_migration_target_not_found':
      return `SSH target "${targetId}" not found`
    case 'orcad_migration_target_owned':
      return 'This SSH target is already owned by another managed runtime.'
    case 'orcad_migration_direct_ssh_repositories':
    case 'orcad_migration_direct_ssh_folder_workspaces':
      return 'This SSH target owns repositories or folder workspaces. Orca cannot live-migrate their control-plane state into a managed server yet; keep this host in direct SSH mode.'
    case 'orcad_migration_direct_ssh_terminal_leases':
      return 'This SSH target still owns terminal sessions. Their PTYs cannot be transferred between the SSH relay and orcad; keep this host in direct SSH mode until that work finishes.'
    case 'orcad_migration_saved_port_forwards':
      return 'This SSH target has saved port forwards. They remain owned by the source target during managed migration.'
    case 'orcad_migration_dependent_state':
      return 'This SSH target still has sessions, workspace metadata, automations, or client routing that the static migration cannot transfer yet. Close or move that state before converting the host.'
  }
}
