import { preserveFolderLineageUncertainty } from '../../../../shared/worktree/lineage/lineage-uncertainty'
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
import {
  buildLineageChildIndex,
  indexMatchesRecords,
  type LineageChildIndex,
  type LineageRecords
} from '../../../../shared/orchestration/lineage-child-index'
import { type WriteSchedulingOperations, scheduleSave } from '../profile-writing/write-scheduling'

type CrossStoreLineageRuntime = Pick<StoreRuntimeState, 'state' | 'lineageChildIndex'>

// One shared empty record, so an absent cross-store map keeps the same identity for the child index.
const NO_CROSS_STORE_LINEAGE: Record<string, unknown> = Object.freeze({})

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

  getWorkspaceLineageUncertainty(): Record<string, true> {
    return (
      this[crossStoreLineagePersistenceContext].runtime.state.workspaceLineageUncertaintyByChild ??
      {}
    )
  }

  getRawCrossStoreWorkspaceLineage(): Record<string, unknown> {
    return (
      this[crossStoreLineagePersistenceContext].runtime.state.crossStoreLineageByChildKey ??
      NO_CROSS_STORE_LINEAGE
    )
  }

  /** The child index of the current lineage records; rebuilt when a save dropped it or a record
   *  object was replaced (load, reload). */
  getLineageChildIndex(): LineageChildIndex {
    const runtime = this[crossStoreLineagePersistenceContext].runtime
    const records: LineageRecords = [
      runtime.state.worktreeLineageById,
      runtime.state.workspaceLineageByChildKey,
      this.getRawCrossStoreWorkspaceLineage()
    ]
    if (!indexMatchesRecords(runtime.lineageChildIndex ?? undefined, records)) {
      runtime.lineageChildIndex = buildLineageChildIndex(records)
    }
    return runtime.lineageChildIndex!
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
    preserveFolderLineageUncertainty(state, lineage.childWorkspaceKey)
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
