import type { WorkspaceAttachmentMutation } from '../../../shared/workspace-attachments/workspace-attachment-mutation'
import type { DiffCommentBaseMutation } from '../../../shared/diff-comment-mutation'

import type { WorkspaceLineage, WorktreeLineage } from '../../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { Repo } from '../../../shared/repo-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { HostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { hasWorktreeRemovalRepoOwnerOnOtherHost } from '../../workspaces/removal/worktree-removal-repo-owner'
import {
  type WorkspaceKey,
  folderWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../shared/workspace-scope'
import { workspaceSessionPartitionIdsForHost } from '../restoring-sessions/session-owner-removal'
import { workspaceSessionPartitionHostId as workspaceSessionOwnerPartitionForHost } from '../../../shared/workspace-session/workspace-session-partition-owner'
import type { StoreRuntimeState } from './store-runtime-state'

import { invalidateLocalWorktreeMetadataPruneInputs } from '../../workspaces/catalog/local-worktree-metadata-prune-gate'
import { type WriteSchedulingOperations, scheduleSave } from './write-scheduling'
import {
  type SessionHostPartitionOperations,
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
    meta: Partial<WorktreeMeta> & WorkspaceAttachmentMutation & DiffCommentBaseMutation
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

  removeUnhostedWorktreeMeta(worktreeId: string): boolean {
    if (this[metadataLineageOperationsContext].runtime.state.worktreeMeta[worktreeId]?.hostId) {
      return false
    }
    this.removeWorktreeMetaRows(worktreeId, undefined)
    return true
  }

  private removeWorktreeMetaRows(worktreeId: string, hostId: ExecutionHostId | undefined): void {
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
    // Match legacy deletion scope; surviving hosts retain their identity rows.
    removeWorktreeMetadataForHost(
      this[metadataLineageOperationsContext].runtime.state,
      worktreeId,
      hostId
    )
    // Do not materialize partitions: that would fence sibling worktrees the host never persisted.
    const partitions = new Set<ExecutionHostId>(
      workspaceSessionPartitionIdsForHost(owner).filter(
        (partition) =>
          hasPersistedWorkspaceSession(
            this[metadataLineageOperationsContext].sessions,
            partition
          ) &&
          // Local can hold remote spill data; preserve it while another owner may use this ID.
          (!preservesSameIdSessionOwner || partition === ownerPartition)
      )
    )
    // Fence only partitions with owned tabs; unrelated siblings must retain unsaved renderer state.
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
      delete this[metadataLineageOperationsContext].runtime.state.crossStoreLineageByChildKey?.[
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
    // Removal may release identity collisions that previously blocked unrelated metadata pruning.
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

  /** Undefined when another host owns this raw-ID lineage bucket. */
  setWorktreeLineage(
    target: HostWorktreeTarget,
    lineage: WorktreeLineage
  ): WorktreeLineage | undefined {
    const state = this[metadataLineageOperationsContext].runtime.state
    if (!ownsRawIdBucket(state, target)) {
      return undefined
    }
    state.worktreeLineageById[target.id] = lineage
    // A child has at most one parent record.
    delete state.crossStoreLineageByChildKey?.[worktreeWorkspaceKey(target.id)]
    scheduleSave(this[metadataLineageOperationsContext].scheduling)
    return lineage
  }

  removeWorktreeLineage(target: HostWorktreeTarget): void {
    const state = this[metadataLineageOperationsContext].runtime.state
    if (!ownsRawIdBucket(state, target)) {
      return
    }
    delete state.worktreeLineageById[target.id]
    delete state.workspaceLineageByChildKey[worktreeWorkspaceKey(target.id)]
    delete state.crossStoreLineageByChildKey?.[worktreeWorkspaceKey(target.id)]
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
      // Legacy identity moves also touch sessions, lineage, mobile selections and UI state.
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
    const state = this[metadataLineageOperationsContext].runtime.state
    state.workspaceLineageByChildKey[lineage.childWorkspaceKey] = lineage
    delete state.crossStoreLineageByChildKey?.[lineage.childWorkspaceKey]
    scheduleSave(this[metadataLineageOperationsContext].scheduling)
    return lineage
  }
}

// The first host stamp owns raw-ID metadata and lineage buckets.
export function ownsRawIdBucket(
  state: MetadataLineageOperationsRuntime['state'],
  target: HostWorktreeTarget
): boolean {
  const owner = state.worktreeMeta[target.id]?.hostId
  return !owner || owner === target.hostId
}

export function removeWorkspaceLineageForRemovedFolder(
  owner: MetadataLineageOperations,
  folderWorkspaceId: string
): void {
  const folderKey = folderWorkspaceKey(folderWorkspaceId)
  // A cross-store record moves or drops with its child only.
  delete owner[metadataLineageOperationsContext].runtime.state.crossStoreLineageByChildKey?.[
    folderKey
  ]
  for (const [childKey, lineage] of Object.entries(
    owner[metadataLineageOperationsContext].runtime.state.workspaceLineageByChildKey
  )) {
    if (lineage.parentWorkspaceKey === folderKey) {
      delete owner[metadataLineageOperationsContext].runtime.state.workspaceLineageByChildKey[
        childKey as WorkspaceKey
      ]
    }
  }
}
