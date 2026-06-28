import {
  initialDebounceState,
  reconcileIndicator,
  worktreeIndicatorKind,
  type IndicatorDebounceState,
  type StatusIndicatorKind
} from './agent-state-indicator'
import type { WorktreeRow } from './worktree-snapshot'

/** Per-worktree indicator debounce, kept out of the controller so the anti-strobe
 *  bookkeeping (and its two maps) live in one focused place. Fold the latest rows
 *  in with {@link reconcile}, then read the smoothed kind via {@link kindFor}. */
export class IndicatorDebounceMap {
  private readonly published = new Map<string, StatusIndicatorKind>()
  private readonly state = new Map<string, IndicatorDebounceState>()

  reconcile(rows: readonly WorktreeRow[], now: number): void {
    const seen = new Set<string>()
    for (const row of rows) {
      seen.add(row.worktreeId)
      const raw = worktreeIndicatorKind(row.status, row.agents)
      const prev = this.state.get(row.worktreeId) ?? initialDebounceState(raw)
      const result = reconcileIndicator(prev, raw, now)
      this.state.set(row.worktreeId, result.state)
      this.published.set(row.worktreeId, result.published)
    }
    for (const id of this.state.keys()) {
      if (!seen.has(id)) {
        this.state.delete(id)
        this.published.delete(id)
      }
    }
  }

  kindFor = (row: WorktreeRow): StatusIndicatorKind =>
    this.published.get(row.worktreeId) ?? worktreeIndicatorKind(row.status, row.agents)
}
