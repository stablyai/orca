import type { WorkspaceAttachmentMutation } from '../../../../shared/workspace-attachments/workspace-attachment-mutation'
import type { DiffCommentBaseMutation } from '../../../../shared/diff-comment-mutation'

import type { WorkspaceLineage, WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import { toWorkspaceLineageRow } from '../../../../shared/worktree/lineage/worktree-lineage-workspace-row'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { Repo } from '../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { HostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { hasWorktreeRemovalRepoOwnerOnOtherHost } from '../../../workspaces/removal/worktree-removal-repo-owner'
import {
  type WorkspaceKey,
  folderWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace-scope'
import { workspaceSessionPartitionIdsForHost } from '../../restoring-sessions/session-owner-removal'
import { workspaceSessionPartitionHostId as workspaceSessionOwnerPartitionForHost } from '../../../../shared/workspace-session/workspace-session-partition-owner'
import { dropScheduledMessagesForWorktree } from '../../scheduled-message-worktree-sweep'
import type { StoreRuntimeState } from '../store-runtime-state'

import { invalidateLocalWorktreeMetadataPruneInputs } from '../../../workspaces/catalog/local-worktree-metadata-prune-gate'
import { type WriteSchedulingOperations, scheduleSave } from '../profile-writing/write-scheduling'
import {
  type SessionHostPartitionOperations,
  hasPersistedWorkspaceSession,
  partitionOwnsWorktreeTabs,
  partitionHasOtherRepoWorktreeTabs,
  removeWorkspaceSessionOwnerInPartition
} from '../workspace-sessions/session-host-partitions'
import { migrateWorktreeIdentity as migrateWorktreeIdentityOperation } from '../../tracking-repos/worktree-identity-migration'
import {
  getAllWorktreeMetaForHost as getAllWorktreeMetaForHostOperation,
  getWorktreeMetaForHost as getWorktreeMetaForHostOperation,
  migrateWorktreeMetadataLocator,
  removeWorktreeMetadataForHost,
  setWorktreeMetaForHost as setWorktreeMetaForHostOperation
} from '../worktree-metadata/worktree-identity-metadata'
import * as saved from '../../profile-save-domains'
import {
  pruneSessionlessMissingLocalWorktreeMetadataForRepo as pruneSessionlessMissingLocalWorktreeMetadataForRepoOperation,
  selectProbeableLocalWorktreeMetadataCandidates as selectProbeableLocalWorktreeMetadataCandidatesOperation
} from '../../tracking-repos/missing-local-worktree-metadata-pruning'
import {
  captureNativeLocalWorktreeMetadataScanExpectation as captureNativeLocalWorktreeMetadataScanExpectationOperation,
  type LocalWorktreeMetadataPruneExpectation,
  type NativeLocalWorktreeMetadataScanExpectation
} from '../../tracking-repos/local-worktree-metadata-scan-expectation'

type MetadataLineageOperationsRuntime = Pick<StoreRuntimeState, 'state'>

const metadataLineageOperationsContext = Symbol('MetadataLineageOperations')
type MetadataLineageOperationsContext = {
  runtime: MetadataLineageOperationsRuntime
  scheduling: WriteSchedulingOperations
  sessions: SessionHostPartitionOperations
}

function saveDomains(owner: MetadataLineageOperations, domains: readonly string[]): void {
  scheduleSave(owner[metadataLineageOperationsContext].scheduling, domains)
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
      dropScheduledMessagesForWorktree(
        this[metadataLineageOperationsContext].runtime.state,
        worktreeId
      )
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
    saveDomains(this, saved.WORKTREE_METADATA_REMOVAL_DOMAINS)
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
      saveDomains(this, saved.WORKTREE_METADATA_PRUNE_DOMAINS)
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
    // A child has at most one parent record; the workspace row mirrors this link.
    state.workspaceLineageByChildKey[worktreeWorkspaceKey(target.id)] =
      toWorkspaceLineageRow(lineage)
    delete state.crossStoreLineageByChildKey?.[worktreeWorkspaceKey(target.id)]
    saveDomains(this, saved.WORKSPACE_LINEAGE_DOMAINS)
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
    saveDomains(this, saved.WORKSPACE_LINEAGE_DOMAINS)
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
      saveDomains(
        this,
        legacyChanged ? saved.WORKTREE_IDENTITY_MIGRATION_DOMAINS : saved.WORKTREE_METADATA_DOMAINS
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

  /** For a worktree parent whose worktree link couldn't be recorded; folder parents use
   * setFolderParentLineage, which keeps the child to one parent. */
  setWorkspaceLineage(lineage: WorkspaceLineage): WorkspaceLineage {
    const state = this[metadataLineageOperationsContext].runtime.state
    state.workspaceLineageByChildKey[lineage.childWorkspaceKey] = lineage
    delete state.crossStoreLineageByChildKey?.[lineage.childWorkspaceKey]
    saveDomains(this, ['workspaceLineageByChildKey', 'crossStoreLineageByChildKey'])
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
