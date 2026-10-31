import { WORKSPACE_ROW_FILTER_UI_FIELDS } from '../../../src/shared/workspace-view/workspace-row-filters'
import type {
  MobileViewPatch,
  MobileViewState,
  WorkspaceViewSettings
} from '../worktree/workspace-view-settings'

// Show the desired value until the desktop answers; a slow response is not a refusal.
export type PendingViewChange = { opId: number; sentAt: number } & (
  | {
      kind: 'view'
      patch: MobileViewPatch
      payload: WorkspaceViewSettings
      filterRepoIdsMode?: 'exact'
      dispatched?: true
    }
  | { kind: 'collapse'; key: string; collapsed: boolean }
)

export const PENDING_VIEW_CHANGE_STALE_MS = 10_000

export function applyViewPatch(view: MobileViewState, patch: MobileViewPatch): MobileViewState {
  return { ...view, ...patch, filters: { ...view.filters, ...patch.filters } }
}

export function applyCollapse(
  view: MobileViewState,
  key: string,
  collapsed: boolean
): MobileViewState {
  const rest = view.collapsedGroups.filter((candidate) => candidate !== key)
  return { ...view, collapsedGroups: collapsed ? [...rest, key] : rest }
}

export function withPendingViewChanges(
  view: MobileViewState,
  pending: readonly PendingViewChange[]
): MobileViewState {
  return pending.reduce(
    (current, change) =>
      change.kind === 'view'
        ? applyViewPatch(current, change.patch)
        : applyCollapse(current, change.key, change.collapsed),
    view
  )
}

function writesOf(change: PendingViewChange): Map<string, (ui: WorkspaceViewSettings) => boolean> {
  if (change.kind === 'collapse') {
    return new Map([
      [
        `collapse:${change.key}`,
        (ui) => (ui.collapsedGroups?.includes(change.key) ?? false) === change.collapsed
      ]
    ])
  }
  return new Map(
    Object.entries(change.payload).map(([field, value]) => [
      field,
      (ui) => JSON.stringify(new Map(Object.entries(ui)).get(field)) === JSON.stringify(value)
    ])
  )
}

export function addPendingViewChange(
  pending: readonly PendingViewChange[],
  change: PendingViewChange
): PendingViewChange[] {
  const writes = writesOf(change)
  return [
    ...pending.flatMap<PendingViewChange>((earlier) => {
      if (earlier.kind === 'collapse') {
        return writes.has(`collapse:${earlier.key}`) ? [] : [earlier]
      }
      if (![...writesOf(earlier).keys()].some((key) => writes.has(key))) {
        return [earlier]
      }
      const payload = Object.fromEntries(
        Object.entries(earlier.payload).filter(([key]) => !writes.has(key))
      )
      if (!Object.keys(payload).length) {
        return []
      }
      const filters =
        earlier.patch.filters &&
        Object.fromEntries(
          Object.entries(earlier.patch.filters).filter(
            ([key]) =>
              !Object.entries(WORKSPACE_ROW_FILTER_UI_FIELDS).some(
                ([filter, field]) => filter === key && writes.has(field)
              )
          )
        )
      const patch = Object.fromEntries(
        Object.entries(earlier.patch).filter(([key]) => key !== 'filters' && !writes.has(key))
      )
      const { filterRepoIdsMode, ...rest } = earlier
      return [
        {
          ...rest,
          payload,
          patch: { ...patch, ...(filters && Object.keys(filters).length ? { filters } : {}) },
          ...(payload.filterRepoIds !== undefined && filterRepoIdsMode ? { filterRepoIdsMode } : {})
        }
      ]
    }),
    change
  ]
}

// Judge only changes sent before the read; later overlapping writes belong to the newer change.
export function reconcilePendingViewChanges(
  pending: readonly PendingViewChange[],
  ui: WorkspaceViewSettings,
  sentByOpId: number
): PendingViewChange[] {
  return pending.filter((change, index) => {
    if (
      change.opId > sentByOpId ||
      (change.kind === 'view' && change.filterRepoIdsMode === 'exact' && !change.dispatched)
    ) {
      return true
    }
    const later = new Set(pending.slice(index + 1).flatMap((next) => [...writesOf(next).keys()]))
    return [...writesOf(change)].some(([key, holds]) => !later.has(key) && !holds(ui))
  })
}
