import type { WorkspaceAttachmentMutation } from '../../../shared/workspace-attachment-mutation'
import type { WorkspaceKey } from '../../../shared/folder-workspace-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { Repo } from '../../../shared/repo-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { HostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { hasWorktreeRemovalRepoOwnerOnOtherHost } from '../../worktree-removal-repo-owner'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import {
  workspaceSessionOwnerPartitionForHost,
  workspaceSessionPartitionIdsForHost
} from '../restoring-sessions/session-owner-removal'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import type { SessionHostPartitionOperations } from './session-host-partitions'
import { invalidateLocalWorktreeMetadataPruneInputs } from '../../local-worktree-metadata-prune-gate'
import { scheduleSave } from './write-scheduling'
import {
  hasPersistedWorkspaceSession,
  partitionOwnsWorktreeTabs,
  partitionHasOtherRepoWorktreeTabs,
  removeWorkspaceSessionOwnerInPartition
} from './session-host-partitions'
import { migrateWorktreeIdentity as migrateWorktreeIdentityOperation } from '../tracking-repos/worktree-identity-migration'
import {
  getAllWorktreeMetaForHost as getAllWorktreeMetaForHostOperation,
  getWorktreeMetaForHost as getWorktreeMetaForHostOperation,
  migrateWorktreeMetadataLocator,
  removeWorktreeMetadataForHost,
  setWorktreeMetaForHost as setWorktreeMetaForHostOperation,
  WORKTREE_METADATA_DOMAINS
} from './worktree-identity-metadata'
import {
  captureNativeLocalWorktreeMetadataScanExpectation as captureNativeLocalWorktreeMetadataScanExpectationOperation,
  pruneSessionlessMissingLocalWorktreeMetadataForRepo as pruneSessionlessMissingLocalWorktreeMetadataForRepoOperation,
  selectProbeableLocalWorktreeMetadataCandidates as selectProbeableLocalWorktreeMetadataCandidatesOperation,
  type LocalWorktreeMetadataPruneExpectation,
  type NativeLocalWorktreeMetadataScanExpectation
} from '../tracking-repos/missing-local-worktree-metadata-pruning'

type MetadataLineageOperationsRuntime = Pick<StoreRuntimeState, 'state'>

const metadataLineageOperationsContext = Symbol('MetadataLineageOperations')
type MetadataLineageOperationsContext = {
  runtime: MetadataLineageOperationsRuntime
  scheduling: WriteSchedulingOperations
  sessions: SessionHostPartitionOperations
}

export class MetadataLineageOperations {
  readonly [metadataLineageOperationsContext]: MetadataLineageOperationsContext

  constructor(
    runtime: MetadataLineageOperationsRuntime,
    scheduling: WriteSchedulingOperations,
    sessions: SessionHostPartitionOperations
  ) {
    this[metadataLineageOperationsContext] = { runtime, scheduling, sessions }
  }
  getWorktreeMeta(worktreeId: string): WorktreeMeta | undefined {
    return this[metadataLineageOperationsContext].runtime.state.worktreeMeta[worktreeId]
  }

  getWorktreeMetaForHost(
    worktreeId: string,
    executionHostId: ExecutionHostId
  ): WorktreeMeta | undefined {
    return getWorktreeMetaForHostOperation(
      this[metadataLineageOperationsContext].runtime,
      this[metadataLineageOperationsContext].scheduling,
      worktreeId,
      executionHostId
    )
  }

  getAllWorktreeMeta(): Record<string, WorktreeMeta> {
    return this[metadataLineageOperationsContext].runtime.state.worktreeMeta
  }

  getAllWorktreeMetaForHost(executionHostId: ExecutionHostId): Record<string, WorktreeMeta> {
    return getAllWorktreeMetaForHostOperation(
      this[metadataLineageOperationsContext].runtime,
      executionHostId
    )
  }

  captureNativeLocalWorktreeMetadataScanExpectation(
    repo: Repo
  ): NativeLocalWorktreeMetadataScanExpectation {
    return captureNativeLocalWorktreeMetadataScanExpectationOperation(
      this[metadataLineageOperationsContext].runtime.state,
      repo
    )
  }

  setWorktreeMeta(
    target: HostWorktreeTarget,
    meta: Partial<WorktreeMeta> & WorkspaceAttachmentMutation
  ): WorktreeMeta {
    return setWorktreeMetaForHostOperation(
      this[metadataLineageOperationsContext].runtime,
      this[metadataLineageOperationsContext].scheduling,
      target.id,
      target.hostId,
      meta
    )
  }

  removeWorktreeMeta(target: HostWorktreeTarget): void {
    this.removeWorktreeMetaRows(target.id, target.hostId)
  }

  /** For a row no host stamped: removes every host's copy, and refuses a stamped row. */
  removeUnhostedWorktreeMeta(worktreeId: string): boolean {
    if (this[metadataLineageOperationsContext].runtime.state.worktreeMeta[worktreeId]?.hostId) {
      return false
    }
    this.removeWorktreeMetaRows(worktreeId, undefined)
    return true
  }

  private removeWorktreeMetaRows(worktreeId: string, hostId: ExecutionHostId | undefined): void {
    // A host-qualified removal names the owner; the persisted host is the fallback.
    const persistedOwner =
      this[metadataLineageOperationsContext].runtime.state.worktreeMeta[worktreeId]?.hostId
    const owner = hostId ?? persistedOwner
    const preservesDifferentPersistedOwner = Boolean(
      hostId && persistedOwner && persistedOwner !== hostId
    )
    const ownerPartition = workspaceSessionOwnerPartitionForHost(owner)
    const preservesSameIdSessionOwner = Boolean(
      preservesDifferentPersistedOwner ||
      (owner &&
        hasWorktreeRemovalRepoOwnerOnOtherHost(
          { getRepos: () => this[metadataLineageOperationsContext].runtime.state.repos },
          getRepoIdFromWorktreeId(worktreeId),
          ownerPartition
        ))
    )
    // Mirror the legacy delete's scope below: a full removal takes every host's identity rows,
    // otherwise the surviving owner keeps its own.
    removeWorktreeMetadataForHost(
      this[metadataLineageOperationsContext].runtime.state,
      worktreeId,
      hostId
    )
    // Skip partitions main never wrote: materializing one fences every sibling worktree of the repo.
    const partitions = new Set<ExecutionHostId>(
      workspaceSessionPartitionIdsForHost(owner).filter(
        (partition) =>
          hasPersistedWorkspaceSession(
            this[metadataLineageOperationsContext].sessions,
            partition
          ) &&
          // The local partition can be a remote spill surface or a same-id owner.
          // Preserve it whenever another owner may still use the bare id.
          (!preservesSameIdSessionOwner || partition === ownerPartition)
      )
    )
    // A repo-wide fence must not rebase a sibling's unpersisted tabs onto main's copy, and a spill
    // partition that never held this worktree has no claim on the repo at all.
    const fencedPartitions = new Set(
      [...partitions].filter(
        (partition) =>
          partitionOwnsWorktreeTabs(
            this[metadataLineageOperationsContext].sessions,
            worktreeId,
            partition
          ) ||
          (partition === ownerPartition &&
            !partitionHasOtherRepoWorktreeTabs(
              this[metadataLineageOperationsContext].sessions,
              worktreeId,
              partition
            ))
      )
    )
    if (!preservesDifferentPersistedOwner) {
      delete this[metadataLineageOperationsContext].runtime.state.worktreeMeta[worktreeId]
      delete this[metadataLineageOperationsContext].runtime.state.worktreeLineageById[worktreeId]
      delete this[metadataLineageOperationsContext].runtime.state.workspaceLineageByChildKey[
        worktreeWorkspaceKey(worktreeId)
      ]
    }
    for (const partition of partitions) {
      removeWorkspaceSessionOwnerInPartition(
        this[metadataLineageOperationsContext].sessions,
        worktreeId,
        partition,
        {
          advanceTerminalTopologyRevision: fencedPartitions.has(partition)
        }
      )
    }
    // Why: dropping a row can free the identity key that was vetoing an unrelated row's removal, so
    // the metadata prune needs to look again — it is otherwise waiting on evidence (#17775).
    invalidateLocalWorktreeMetadataPruneInputs()
    scheduleSave(this[metadataLineageOperationsContext].scheduling)
  }

  selectProbeableLocalWorktreeMetadataCandidates(
    scan: NativeLocalWorktreeMetadataScanExpectation
  ): readonly LocalWorktreeMetadataPruneExpectation[] {
    return selectProbeableLocalWorktreeMetadataCandidatesOperation(
      this[metadataLineageOperationsContext].runtime.state,
      scan
    )
  }

  pruneSessionlessMissingLocalWorktreeMetadataForRepo(
    scan: NativeLocalWorktreeMetadataScanExpectation,
    missingMetadata: readonly LocalWorktreeMetadataPruneExpectation[]
  ): string[] {
    const removed = pruneSessionlessMissingLocalWorktreeMetadataForRepoOperation(
      this[metadataLineageOperationsContext].runtime.state,
      scan,
      missingMetadata
    )
    if (removed.length > 0) {
      scheduleSave(this[metadataLineageOperationsContext].scheduling)
    }
    return removed
  }

  getWorktreeLineage(worktreeId: string): WorktreeLineage | undefined {
    return this[metadataLineageOperationsContext].runtime.state.worktreeLineageById[worktreeId]
  }

  getAllWorktreeLineage(): Record<string, WorktreeLineage> {
    return this[metadataLineageOperationsContext].runtime.state.worktreeLineageById
  }

  /** Undefined when the id's lineage bucket belongs to a same-id twin on another host. */
  setWorktreeLineage(
    target: HostWorktreeTarget,
    lineage: WorktreeLineage
  ): WorktreeLineage | undefined {
    const state = this[metadataLineageOperationsContext].runtime.state
    if (!ownsRawIdBucket(state, target)) {
      return undefined
    }
    state.worktreeLineageById[target.id] = lineage
    scheduleSave(this[metadataLineageOperationsContext].scheduling)
    return lineage
  }

  /** Drops both lineage records of a worktree, unless a same-id twin on another host owns them. */
  removeWorktreeLineage(target: HostWorktreeTarget): void {
    const state = this[metadataLineageOperationsContext].runtime.state
    if (!ownsRawIdBucket(state, target)) {
      return
    }
    delete state.worktreeLineageById[target.id]
    delete state.workspaceLineageByChildKey[worktreeWorkspaceKey(target.id)]
    scheduleSave(this[metadataLineageOperationsContext].scheduling)
  }

  migrateWorktreeIdentity(target: HostWorktreeTarget, newWorktreeId: string): void {
    const state = this[metadataLineageOperationsContext].runtime.state
    const legacyChanged =
      ownsRawIdBucket(state, target) &&
      migrateWorktreeIdentityOperation(state, target.id, newWorktreeId)
    const canonicalChanged = migrateWorktreeMetadataLocator(
      state,
      target.id,
      newWorktreeId,
      target.hostId
    )
    if (legacyChanged || canonicalChanged) {
      // Legacy identity moves also re-key sessions, lineage, mobile selections, and UI state.
      scheduleSave(
        this[metadataLineageOperationsContext].scheduling,
        legacyChanged ? undefined : WORKTREE_METADATA_DOMAINS
      )
    }
  }

  getWorkspaceLineage(childWorkspaceKey: WorkspaceKey): WorkspaceLineage | undefined {
    return this[metadataLineageOperationsContext].runtime.state.workspaceLineageByChildKey[
      childWorkspaceKey
    ]
  }

  getAllWorkspaceLineage(): Record<WorkspaceKey, WorkspaceLineage> {
    return this[metadataLineageOperationsContext].runtime.state.workspaceLineageByChildKey
  }

  setWorkspaceLineage(lineage: WorkspaceLineage): WorkspaceLineage {
    this[metadataLineageOperationsContext].runtime.state.workspaceLineageByChildKey[
      lineage.childWorkspaceKey
    ] = lineage
    scheduleSave(this[metadataLineageOperationsContext].scheduling)
    return lineage
  }
}

// Raw-id buckets (legacy meta, lineage) belong to the first host that stamped the id (D7).
function ownsRawIdBucket(
  state: MetadataLineageOperationsRuntime['state'],
  target: HostWorktreeTarget
): boolean {
  const owner = state.worktreeMeta[target.id]?.hostId
  return !owner || owner === target.hostId
}

export function removeWorkspaceLineageForFolderParent(
  owner: MetadataLineageOperations,
  folderWorkspaceId: string
): void {
  const parentKey = folderWorkspaceKey(folderWorkspaceId)
  for (const [childKey, lineage] of Object.entries(
    owner[metadataLineageOperationsContext].runtime.state.workspaceLineageByChildKey
  )) {
    if (lineage.parentWorkspaceKey === parentKey) {
      delete owner[metadataLineageOperationsContext].runtime.state.workspaceLineageByChildKey[
        childKey as WorkspaceKey
      ]
    }
  }
}
