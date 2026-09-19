import type { PersistedState } from '../../shared/persisted-state-types'

// Scheduled messages live outside `worktreeMeta`: a row outliving its workspace fails at
// its due time (`no-pane`), or for `when-idle` never fires at all.

export function dropScheduledMessagesForWorktree(
  state: PersistedState,
  worktreeId: string
): boolean {
  return dropScheduledMessagesWhere(state, (id) => id === worktreeId)
}

export function dropScheduledMessagesWhere(
  state: PersistedState,
  matches: (worktreeId: string) => boolean
): boolean {
  const existing = state.scheduledMessages ?? []
  const remaining = existing.filter((entry) => !matches(entry.worktreeId))
  if (remaining.length === existing.length) {
    return false
  }
  state.scheduledMessages = remaining
  return true
}
