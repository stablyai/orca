import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceKey } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { CrossStoreWorkspaceLineage } from '../../../shared/worktree/lineage-types'
import { hostWorktreeTarget } from '../../../shared/worktree/host-qualified-identity'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { validCrossStoreLineage } from '../../../shared/worktree/cross-store-lineage-records'
import { ownsRawIdBucket } from './metadata-lineage-operations'
import type { StoreRuntimeState } from './store-runtime-state'
import { type WriteSchedulingOperations, scheduleSave } from './write-scheduling'

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
    return validCrossStoreLineage(
      this[crossStoreLineagePersistenceContext].runtime.state.crossStoreLineageByChildKey
    )[childWorkspaceKey]
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
    scheduleSave(this[crossStoreLineagePersistenceContext].scheduling)
    return lineage
  }

  removeCrossStoreWorkspaceLineage(
    lineage: CrossStoreWorkspaceLineage,
    childHostId: ExecutionHostId
  ): void {
    const { state } = this[crossStoreLineagePersistenceContext].runtime
    const { childWorkspaceKey } = lineage
    if (
      !state.crossStoreLineageByChildKey?.[childWorkspaceKey] ||
      !ownsChildBucket(state, childWorkspaceKey, childHostId)
    ) {
      return
    }
    delete state.crossStoreLineageByChildKey[childWorkspaceKey]
    scheduleSave(this[crossStoreLineagePersistenceContext].scheduling)
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
