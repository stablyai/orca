import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import type {
  SetCollapsedRequest,
  SetCollapsedResult
} from '../../shared/rpc-contract/workspace-view-collapse-params'

// Far above writers x sections in use; an evicted entry only lets a very old retry apply again.
const MAX_TRACKED_WRITES = 4096

/**
 * The newest seq each writer applied to each section. Across writers the last arrival wins; a
 * writer's own repeated or reordered op is a no-op, so phone A retrying a collapse that already
 * landed cannot undo phone B's later expand. In memory: a restart forgets it.
 */
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
  getUIState(): Pick<PersistedUIState, 'collapsedGroups'>
  updateUIState(updates: Pick<PersistedUIState, 'collapsedGroups'>): unknown
}

/** Changes one section in the persisted collapsed set, leaving every other section as it is. */
export function setCollapsedSection(
  ui: CollapseUiState,
  order: CollapseWriteOrder,
  request: SetCollapsedRequest
): SetCollapsedResult {
  const current = ui.getUIState().collapsedGroups
  const collapsed = current.includes(request.key)
  if (order.isSettled(request)) {
    return { collapsed, applied: false }
  }
  if (collapsed !== request.collapsed) {
    ui.updateUIState({
      collapsedGroups: request.collapsed
        ? [...current, request.key]
        : current.filter((key) => key !== request.key)
    })
  }
  order.record(request)
  return { collapsed: request.collapsed, applied: true }
}
