/**
 * Exclusive managed-orcad ownership of an SSH target. A claimed target is hidden from direct SSH
 * surfaces and serves only its environment's tunnel. Only empty targets are claimable, including no
 * saved sessions, automations, worktree metadata or terminal leases: moving a direct SSH host's
 * state into a managed server is the catalog migration, which this does not do.
 */
import type { Store } from '../persistence'
import {
  createManagedOrcadSshOwner,
  getManagedOrcadOwnerEnvironmentId
} from '../../shared/managed-orcad-ssh-owner'
import type {
  OrcadMigrationBlocker,
  OrcadMigrationPreflight
} from '../../shared/orcad-migration-preflight'
import type { SshTarget } from '../../shared/ssh-types'
import {
  collectDependentStateBlockers,
  dependentStateMessage,
  type DependentStateStore
} from './ssh-target-orcad-dependents'

type ClaimStore = DependentStateStore &
  Pick<
    Store,
    | 'allocateSshTargetGeneration'
    | 'flushPendingOrThrowAsync'
    | 'getFolderWorkspaces'
    | 'getRepos'
    | 'getSshTarget'
    | 'getSshTargets'
    | 'updateSshTarget'
  >

export class SshTargetOrcadClaims {
  constructor(private readonly store: ClaimStore) {}

  listTargets(): SshTarget[] {
    return this.store.getSshTargets()
  }

  /** `environmentId` lets that environment's own claim pass; omit it to see every blocker. */
  preflight(targetId: string, environmentId?: string): OrcadMigrationPreflight {
    const target = this.store.getSshTarget(targetId)
    if (!target) {
      return {
        targetId,
        targetLabel: null,
        claimable: false,
        blockers: [{ code: 'orcad_migration_target_not_found', category: 'registration' }]
      }
    }
    if (environmentId && getManagedOrcadOwnerEnvironmentId(target.owner) === environmentId) {
      return { targetId, targetLabel: target.label, claimable: true, blockers: [] }
    }
    const blockers = collectEmptyTargetBlockers(this.store, target)
    return { targetId, targetLabel: target.label, claimable: blockers.length === 0, blockers }
  }

  /**
   * Idempotent for the same environment; the caller makes the claim durable before acting on it.
   * A deploy passes its server name so an interrupted claim reads as pending provisioning.
   */
  claim(targetId: string, environmentId: string, deployName?: string): SshTarget {
    const blocker = this.preflight(targetId, environmentId).blockers[0]
    if (blocker) {
      throw new Error(orcadTargetBlockerMessage(targetId, blocker))
    }
    const target = this.requireTarget(targetId)
    const owned = getManagedOrcadOwnerEnvironmentId(target.owner) === environmentId
    if (owned && target.generation) {
      return target
    }
    const claimed = this.store.updateSshTarget(targetId, {
      owner: createManagedOrcadSshOwner(environmentId),
      generation: target.generation ?? this.store.allocateSshTargetGeneration(),
      ...(deployName && !target.orcadProvisioning
        ? { orcadProvisioning: { requestId: environmentId, name: deployName } }
        : {})
    })
    if (!claimed) {
      throw new Error(`SSH target "${targetId}" disappeared while it was being reserved.`)
    }
    return claimed
  }

  release(targetId: string, environmentId: string): SshTarget | null {
    const target = this.store.getSshTarget(targetId)
    if (!target || getManagedOrcadOwnerEnvironmentId(target.owner) !== environmentId) {
      return null
    }
    return this.store.updateSshTarget(targetId, { owner: undefined, orcadProvisioning: undefined })
  }

  /** Ownership must be on disk before a remote host acts on it. */
  flush(signal?: AbortSignal): Promise<void> {
    return this.store.flushPendingOrThrowAsync({ signal, drainToStableGeneration: false })
  }

  private requireTarget(targetId: string): SshTarget {
    const target = this.store.getSshTarget(targetId)
    if (!target) {
      throw new Error(`SSH target "${targetId}" not found.`)
    }
    return target
  }
}

function collectEmptyTargetBlockers(store: ClaimStore, target: SshTarget): OrcadMigrationBlocker[] {
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
    .filter((repo) => repo.connectionId === target.id)
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
    .filter((workspace) => workspace.connectionId === target.id)
    .map(({ id, name, folderPath }) => ({ id, name, folderPath }))
  if (folderWorkspaces.length > 0) {
    blockers.push({
      code: 'orcad_migration_direct_ssh_folder_workspaces',
      category: 'drainable-static-state',
      folderWorkspaces
    })
  }
  if (target.portForwards?.length) {
    blockers.push({
      code: 'orcad_migration_saved_port_forwards',
      category: 'client-owned-state',
      portForwards: target.portForwards.map((portForward) => ({ ...portForward }))
    })
  }
  blockers.push(...collectDependentStateBlockers(store, target.id))
  return blockers
}

export function orcadTargetBlockerMessage(
  targetId: string,
  blocker: OrcadMigrationBlocker
): string {
  switch (blocker.code) {
    case 'orcad_migration_target_not_found':
      return `SSH target "${targetId}" not found.`
    case 'orcad_migration_target_owned':
      return 'This SSH target is already owned by another managed runtime.'
    case 'orcad_migration_direct_ssh_repositories':
    case 'orcad_migration_direct_ssh_folder_workspaces':
      return 'This SSH target owns repositories or folder workspaces. A managed server can only be created on a host with no direct SSH projects yet; keep this host in direct SSH mode.'
    case 'orcad_migration_direct_ssh_terminal_leases':
      return 'This SSH target still owns terminal sessions. Close them before converting the host.'
    case 'orcad_migration_saved_port_forwards':
      return 'This SSH target has saved port forwards. Remove them before converting the host.'
    case 'orcad_migration_dependent_state':
      return dependentStateMessage(blocker.dependencies)
    case 'orcad_migration_dependency_unverifiable':
      return `Orca could not read its saved ${blocker.sources.join(', ')} state, so it cannot show this SSH target is unused; the target was left in direct SSH mode.`
  }
}
