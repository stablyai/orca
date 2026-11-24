import type { PersistedUIState } from '../../../../shared/orca-profiles/persisted-ui-state-types'
import { reconcileExpandedLineageGroupsList } from '../../../../shared/sidebar-list/lineage/auto-collapse-lineage-state'
import type {
  SetCollapsedRequest,
  SetCollapsedResult
} from '../../../../shared/rpc-contract/workspaces/workspace-view-collapse-params'

// Far above writers x sections in use; an evicted entry only lets a very old retry apply again.
const MAX_TRACKED_WRITES = 4096

/** Reject each writer's repeated/reordered ops without undoing later arrivals from other writers. In-memory state resets on restart. */
export class CollapseWriteOrder {
  private readonly appliedSeq = new Map<string, number>()

  isSettled({ key, opId }: Pick<SetCollapsedRequest, 'key' | 'opId'>): boolean {
    const applied = this.appliedSeq.get(slotOf(key, opId.writer))
    return applied !== undefined && opId.seq <= applied
  }

  record({ key, opId }: Pick<SetCollapsedRequest, 'key' | 'opId'>): void {
    const slot = slotOf(key, opId.writer)
    // Re-inserting keeps the map in least-recently-written order for eviction.
    this.appliedSeq.delete(slot)
    this.appliedSeq.set(slot, opId.seq)
    if (this.appliedSeq.size > MAX_TRACKED_WRITES) {
      const oldest = this.appliedSeq.keys().next().value
      if (oldest !== undefined) {
        this.appliedSeq.delete(oldest)
      }
    }
  }
}

function slotOf(key: string, writer: string): string {
  return JSON.stringify([writer, key])
}

type CollapseUiState = {
  getUIState(): Pick<PersistedUIState, 'collapsedGroups' | 'expandedLineageGroups'>
  updateUIState(
    updates: Partial<Pick<PersistedUIState, 'collapsedGroups' | 'expandedLineageGroups'>>
  ): unknown
  isStartChildWorkspacesCollapsedEnabled?(): boolean
}

export function setCollapsedSection(
  ui: CollapseUiState,
  order: CollapseWriteOrder,
  request: SetCollapsedRequest
): SetCollapsedResult {
  const uiState = ui.getUIState()
  const current = uiState.collapsedGroups
  const collapsed = current.includes(request.key)
  if (order.isSettled(request)) {
    return { collapsed, applied: false }
  }
  const nextExpandedLineageGroups = reconcileExpandedLineageGroupsList({
    key: request.key,
    collapsed: request.collapsed,
    previousExpanded: uiState.expandedLineageGroups,
    trackExplicitExpands: ui.isStartChildWorkspacesCollapsedEnabled?.() === true
  })
  if (collapsed !== request.collapsed || nextExpandedLineageGroups !== undefined) {
    ui.updateUIState({
      ...(collapsed !== request.collapsed
        ? {
            collapsedGroups: request.collapsed
              ? [...current, request.key]
              : current.filter((key) => key !== request.key)
          }
        : {}),
      ...(nextExpandedLineageGroups !== undefined
        ? { expandedLineageGroups: nextExpandedLineageGroups }
        : {})
    })
  }
  order.record(request)
  return { collapsed: request.collapsed, applied: true }
}
