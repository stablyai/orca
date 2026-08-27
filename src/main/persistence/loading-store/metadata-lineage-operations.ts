import { randomUUID } from 'node:crypto'
import type { WorkspaceKey } from '../../../shared/folder-workspace-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { normalizeStoredTaskSourceContext } from '../../../shared/task-source-context'
import { normalizeWorkspaceLinkedItem } from '../../../shared/workspace-linked-item'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../../shared/workspace-linked-item-source-context'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { hasWorktreeRemovalRepoOwnerOnOtherHost } from '../../worktree-removal-repo-owner'
import { DEFAULT_WORKSPACE_STATUS_ID } from '../../../shared/workspace-statuses'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import {
  workspaceSessionOwnerPartitionForHost,
  workspaceSessionPartitionIdsForHost
} from '../restoring-sessions/session-owner-removal'
import { migrateWorktreeIdentity as migrateWorktreeIdentityOperation } from '../tracking-repos/worktree-identity-migration'

function getDefaultWorktreeMeta(): WorktreeMeta {
  return {
    instanceId: randomUUID(),
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    linkedBitbucketPR: null,
    linkedAzureDevOpsPR: null,
    linkedGiteaPR: null,
    linkedWorkItem: null,
    linkedTaskSourceContext: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: Date.now(),
    lastActivityAt: 0,
    workspaceStatus: DEFAULT_WORKSPACE_STATUS_ID
  }
}

import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import type { SessionHostPartitionOperations } from './session-host-partitions'
import { scheduleSave } from './write-scheduling'
import {
  hasPersistedWorkspaceSession,
  partitionOwnsWorktreeTabs,
  partitionHasOtherRepoWorktreeTabs,
  removeWorkspaceSessionOwnerInPartition
} from './session-host-partitions'

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

  getAllWorktreeMeta(): Record<string, WorktreeMeta> {
    return this[metadataLineageOperationsContext].runtime.state.worktreeMeta
  }

  setWorktreeMeta(worktreeId: string, meta: Partial<WorktreeMeta>): WorktreeMeta {
    const existing =
      this[metadataLineageOperationsContext].runtime.state.worktreeMeta[worktreeId] ||
      getDefaultWorktreeMeta()
    const updated = { ...existing, ...meta }
    updated.linkedWorkItem = normalizeWorkspaceLinkedItem(updated.linkedWorkItem)
    const linkedTaskSourceContext = normalizeStoredTaskSourceContext(
      updated.linkedTaskSourceContext
    )
    updated.linkedTaskSourceContext = isWorkspaceLinkedItemSourceContextMatch(
      updated.linkedWorkItem,
      linkedTaskSourceContext
    )
      ? linkedTaskSourceContext
      : null
    if (!updated.instanceId) {
      updated.instanceId = randomUUID()
    }
    this[metadataLineageOperationsContext].runtime.state.worktreeMeta[worktreeId] = updated
    scheduleSave(this[metadataLineageOperationsContext].scheduling)
    return updated
  }

  removeWorktreeMeta(worktreeId: string, hostId?: ExecutionHostId | null): void {
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
    scheduleSave(this[metadataLineageOperationsContext].scheduling)
  }

  getWorktreeLineage(worktreeId: string): WorktreeLineage | undefined {
    return this[metadataLineageOperationsContext].runtime.state.worktreeLineageById[worktreeId]
  }

  getAllWorktreeLineage(): Record<string, WorktreeLineage> {
    return this[metadataLineageOperationsContext].runtime.state.worktreeLineageById
  }

  setWorktreeLineage(worktreeId: string, lineage: WorktreeLineage): WorktreeLineage {
    this[metadataLineageOperationsContext].runtime.state.worktreeLineageById[worktreeId] = lineage
    scheduleSave(this[metadataLineageOperationsContext].scheduling)
    return lineage
  }

  removeWorktreeLineage(worktreeId: string): void {
    delete this[metadataLineageOperationsContext].runtime.state.worktreeLineageById[worktreeId]
    scheduleSave(this[metadataLineageOperationsContext].scheduling)
  }

  migrateWorktreeIdentity(oldWorktreeId: string, newWorktreeId: string): void {
    if (
      migrateWorktreeIdentityOperation(
        this[metadataLineageOperationsContext].runtime.state,
        oldWorktreeId,
        newWorktreeId
      )
    ) {
      scheduleSave(this[metadataLineageOperationsContext].scheduling)
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

  removeWorkspaceLineage(childWorkspaceKey: WorkspaceKey): void {
    delete this[metadataLineageOperationsContext].runtime.state.workspaceLineageByChildKey[
      childWorkspaceKey
    ]
    scheduleSave(this[metadataLineageOperationsContext].scheduling)
  }
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

export function installMetadataLineageOperationsContext(
  target: object,
  source: MetadataLineageOperations
): void {
  Object.defineProperty(target, metadataLineageOperationsContext, {
    value: source[metadataLineageOperationsContext]
  })
}
