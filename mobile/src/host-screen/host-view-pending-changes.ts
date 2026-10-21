import type {
  MobileViewPatch,
  MobileViewState,
  WorkspaceViewSettings
} from '../worktree/workspace-view-settings'

/**
 * A Workspace options change this phone sent that the desktop has not answered yet. The list shows
 * its desired value meanwhile; a slow answer is never a refusal.
 */
export type PendingViewChange = { opId: number; sentAt: number } & (
  | { kind: 'view'; patch: MobileViewPatch; payload: WorkspaceViewSettings }
  | { kind: 'collapse'; key: string; collapsed: boolean }
)

/** After this long without an answer the control says it is still waiting, and keeps the value. */
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

/** The view with every unanswered change laid over it, oldest first. */
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

/** Each stored value the change sets, keyed by what it writes; a collapse writes its one key. */
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

/** Adds a change; an earlier one whose every write it repeats is no longer the user's intent. */
export function addPendingViewChange(
  pending: readonly PendingViewChange[],
  change: PendingViewChange
): PendingViewChange[] {
  const writes = writesOf(change)
  return [
    ...pending.filter((earlier) => [...writesOf(earlier).keys()].some((key) => !writes.has(key))),
    change
  ]
}

/**
 * The changes the desktop's values do not hold yet. Only changes sent before the read are judged
 * by it, and a value a later change also writes is that change's to settle.
 */
export function reconcilePendingViewChanges(
  pending: readonly PendingViewChange[],
  ui: WorkspaceViewSettings,
  sentByOpId: number
): PendingViewChange[] {
  return pending.filter((change, index) => {
    if (change.opId > sentByOpId) {
      return true
    }
    const later = new Set(pending.slice(index + 1).flatMap((next) => [...writesOf(next).keys()]))
    return [...writesOf(change)].some(([key, holds]) => !later.has(key) && !holds(ui))
  })
}
