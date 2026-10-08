/**
 * Exclusive managed-orcad ownership of an SSH target, recorded as its `orcadFence`. A claimed
 * target serves only its environment's tunnel; direct relay connects are refused. Only empty
 * targets are claimable, with no saved sessions, automations, worktree metadata or terminal
 * leases: moving a direct SSH host's state into a managed server is the catalog migration.
 */
import type { Store } from '../persistence'
import { getManagedOrcadFenceEnvironmentId } from '../../shared/managed-orcad-ssh-owner'
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

  /**
   * `owner` lets that environment's own claim pass, but only when the caller holds the durable
   * record that explains it (a provisioning intent, an SSH-access intent or a migration journal).
   * An owner with no such record is unexplained state to recover, never something to reuse.
   */
  preflight(
    targetId: string,
    owner?: { environmentId: string; recorded: boolean }
  ): OrcadMigrationPreflight {
    const target = this.store.getSshTarget(targetId)
    if (!target) {
      return {
        targetId,
        targetLabel: null,
        claimable: false,
        blockers: [{ code: 'orcad_migration_target_not_found', category: 'registration' }]
      }
    }
    const ownedBy = getManagedOrcadFenceEnvironmentId(target)
    if (owner && ownedBy === owner.environmentId) {
      return owner.recorded
        ? { targetId, targetLabel: target.label, claimable: true, blockers: [] }
        : {
            targetId,
            targetLabel: target.label,
            claimable: false,
            blockers: [
              { code: 'orcad_migration_owner_unrecorded', category: 'exclusive-ownership' }
            ]
          }
    }
    const blockers = collectEmptyTargetBlockers(this.store, target)
    return { targetId, targetLabel: target.label, claimable: blockers.length === 0, blockers }
  }

  /**
   * Idempotent for the same environment; the caller makes the claim durable before acting on it.
   * A deploy passes its server name so an interrupted claim reads as pending provisioning.
   */
  claim(
    targetId: string,
    environmentId: string,
    options: { deployName?: string; ownerRecorded: boolean }
  ): SshTarget {
    const { deployName } = options
    const blocker = this.preflight(targetId, {
      environmentId,
      recorded: options.ownerRecorded
    }).blockers[0]
    if (blocker) {
      throw new Error(orcadTargetBlockerMessage(targetId, blocker))
    }
    const target = this.requireTarget(targetId)
    const owned = getManagedOrcadFenceEnvironmentId(target) === environmentId
    if (owned && target.generation) {
      return target
    }
    const claimed = this.store.updateSshTarget(targetId, {
      orcadFence: { environmentId },
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

  /** A durable registration generation, so a fence and its journal bind to one registration. */
  ensureGeneration(targetId: string): number {
    const target = this.requireTarget(targetId)
    if (target.generation !== undefined) {
      return target.generation
    }
    const generation = this.store.allocateSshTargetGeneration()
    if (!this.store.updateSshTarget(targetId, { generation })) {
      throw new Error(`SSH target "${targetId}" disappeared while assigning its generation.`)
    }
    return generation
  }

  /**
   * The migration fence. Unlike `claim`, it skips the empty-target rule: the caller has passed
   * the conversion preflight and written the journal that records this fence.
   */
  fenceForMigration(targetId: string, environmentId: string, generation: number): SshTarget {
    const target = this.requireTarget(targetId)
    if (target.generation !== generation) {
      throw new Error('orcad_migration_target_generation_changed')
    }
    const holder = targetHolder(target)
    if (holder && !(holder.kind === 'managed-server' && holder.environmentId === environmentId)) {
      throw new Error(
        orcadTargetBlockerMessage(targetId, {
          code: 'orcad_migration_target_owned',
          category: 'exclusive-ownership',
          holder
        })
      )
    }
    const fenced = this.store.updateSshTarget(targetId, { orcadFence: { environmentId } })
    if (!fenced) {
      throw new Error(`SSH target "${targetId}" disappeared while it was being fenced.`)
    }
    return fenced
  }

  release(targetId: string, environmentId: string): SshTarget | null {
    const target = this.store.getSshTarget(targetId)
    if (!target || getManagedOrcadFenceEnvironmentId(target) !== environmentId) {
      return null
    }
    return this.store.updateSshTarget(targetId, {
      orcadFence: undefined,
      orcadProvisioning: undefined
    })
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
  return [
    ...collectTargetCatalogBlockers(store, target),
    ...collectDependentStateBlockers(store, target.id)
  ]
}

/** Ownership, the catalog rows the target owns, and its saved port forwards. */
export function collectTargetCatalogBlockers(
  store: Pick<Store, 'getFolderWorkspaces' | 'getRepos'>,
  target: SshTarget
): OrcadMigrationBlocker[] {
  const blockers: OrcadMigrationBlocker[] = []
  const holder = targetHolder(target)
  if (holder) {
    blockers.push({ code: 'orcad_migration_target_owned', category: 'exclusive-ownership', holder })
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
  return blockers
}

/** Who holds the target exclusively: an ephemeral runtime or a managed Orca server. */
function targetHolder(
  target: SshTarget
): Extract<OrcadMigrationBlocker, { code: 'orcad_migration_target_owned' }>['holder'] | null {
  if (target.owner) {
    return { kind: 'runtime', runtimeId: target.owner.runtimeId }
  }
  const environmentId = getManagedOrcadFenceEnvironmentId(target)
  return environmentId ? { kind: 'managed-server', environmentId } : null
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
    case 'orcad_migration_owner_unrecorded':
      return 'This SSH target is held for this server, but no record explains why. Recover the server before reusing the host.'
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
