import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { WORKSPACE_LINEAGE_DOMAINS } from '../../profile-save-domains'
import type { WorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import type { CrossStoreWorkspaceLineage } from '../../../../shared/worktree/lineage-types'
import { hostWorktreeTarget } from '../../../../shared/worktree/host-qualified-identity'
import { parseWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { releaseMatchingLineage } from './workspace-lineage-release'
import {
  isCrossStoreWorkspaceLineage,
  validCrossStoreLineage
} from '../../../../shared/worktree/lineage/cross-store-lineage-records'
import { ownsRawIdBucket } from './metadata-lineage-operations'
import type { StoreRuntimeState } from '../store-runtime-state'
import { type WriteSchedulingOperations, scheduleSave } from '../profile-writing/write-scheduling'

type CrossStoreLineageRuntime = Pick<StoreRuntimeState, 'state'>

const crossStoreLineagePersistenceContext = Symbol('CrossStoreLineagePersistence')
type CrossStoreLineagePersistenceContext = {
  runtime: CrossStoreLineageRuntime
  scheduling: WriteSchedulingOperations
}

/** Parents saved in another Orca store, keyed and maintained by the child only. */
export class CrossStoreLineagePersistence {
  readonly [crossStoreLineagePersistenceContext]: CrossStoreLineagePersistenceContext

  constructor(runtime: CrossStoreLineageRuntime, scheduling: WriteSchedulingOperations) {
    this[crossStoreLineagePersistenceContext] = { runtime, scheduling }
  }

  getCrossStoreWorkspaceLineage(
    childWorkspaceKey: WorkspaceKey
  ): CrossStoreWorkspaceLineage | undefined {
    const saved =
      this[crossStoreLineagePersistenceContext].runtime.state.crossStoreLineageByChildKey
    const entry =
      saved && Object.hasOwn(saved, childWorkspaceKey) ? saved[childWorkspaceKey] : undefined
    return isCrossStoreWorkspaceLineage(entry) && entry.childWorkspaceKey === childWorkspaceKey
      ? entry
      : undefined
  }

  getAllCrossStoreWorkspaceLineage(): Record<WorkspaceKey, CrossStoreWorkspaceLineage> {
    return validCrossStoreLineage(
      this[crossStoreLineagePersistenceContext].runtime.state.crossStoreLineageByChildKey
    )
  }

  /** Replaces the child's same-store parent; undefined when another host owns its raw-ID bucket. */
  setCrossStoreWorkspaceLineage(
    lineage: CrossStoreWorkspaceLineage,
    childHostId: ExecutionHostId
  ): CrossStoreWorkspaceLineage | undefined {
    const { state } = this[crossStoreLineagePersistenceContext].runtime
    if (!ownsChildBucket(state, lineage.childWorkspaceKey, childHostId)) {
      return undefined
    }
    const child = parseWorkspaceKey(lineage.childWorkspaceKey)
    if (child?.type === 'worktree') {
      delete state.worktreeLineageById[child.worktreeId]
    }
    delete state.workspaceLineageByChildKey[lineage.childWorkspaceKey]
    state.crossStoreLineageByChildKey ??= {}
    state.crossStoreLineageByChildKey[lineage.childWorkspaceKey] = lineage
    scheduleSave(this[crossStoreLineagePersistenceContext].scheduling, WORKSPACE_LINEAGE_DOMAINS)
    return lineage
  }

  /** Drops the links that match; returns the children it released. */
  removeCrossStoreWorkspaceLineage(
    matches: (lineage: CrossStoreWorkspaceLineage) => boolean
  ): WorkspaceKey[] {
    const saved =
      this[crossStoreLineagePersistenceContext].runtime.state.crossStoreLineageByChildKey
    const all = Object.values(this.getAllCrossStoreWorkspaceLineage())
    return releaseMatchingLineage(saved, all, matches, () =>
      scheduleSave(this[crossStoreLineagePersistenceContext].scheduling, WORKSPACE_LINEAGE_DOMAINS)
    )
  }
}

function ownsChildBucket(
  state: CrossStoreLineageRuntime['state'],
  childWorkspaceKey: WorkspaceKey,
  childHostId: ExecutionHostId
): boolean {
  const child = parseWorkspaceKey(childWorkspaceKey)
  return (
    child?.type !== 'worktree' ||
    ownsRawIdBucket(state, hostWorktreeTarget({ id: child.worktreeId, hostId: childHostId }))
  )
}
