import type { AgentDotState } from '../worktree/agent-row-display'

type TabCompletionTrackerEntry = {
  sawInTurn: boolean
  unread: boolean
  acknowledgedDoneAt?: number
}

const tabCompletionTracker = new Map<string, TabCompletionTrackerEntry>()
const unreadWorktreeIds = new Set<string>()

export function clearTabCompletionEntriesForTests(): void {
  tabCompletionTracker.clear()
  unreadWorktreeIds.clear()
}

export function isInTurnDotState(state: AgentDotState | null | undefined): boolean {
  return state === 'working' || state === 'monitoring' || state === 'waiting' || state === 'blocked'
}

export function markWorktreeUnreadForTabCompletion(worktreeId: string | null | undefined): void {
  if (!worktreeId) {
    return
  }
  unreadWorktreeIds.add(worktreeId)
}

export function hasPendingWorktreeUnreadForTabCompletion(
  worktreeId: string | null | undefined
): boolean {
  return typeof worktreeId === 'string' && unreadWorktreeIds.has(worktreeId)
}

export function consumeWorktreeUnreadForTabCompletion(
  worktreeId: string | null | undefined
): boolean {
  if (!worktreeId) {
    return false
  }
  return unreadWorktreeIds.delete(worktreeId)
}

export function hasUnacknowledgedTabCompletion(
  keys: readonly string[],
  rawState: AgentDotState | undefined
): boolean {
  if (rawState !== 'done') {
    return false
  }
  for (const key of keys) {
    const entry = tabCompletionTracker.get(key)
    if (entry?.unread || entry?.sawInTurn) {
      return true
    }
  }
  return false
}

export function recordCatalogAgentTabState(args: {
  keys: readonly string[]
  rawState: AgentDotState | undefined
  doneStamp?: number
  forceUnreadIfUnacknowledged?: boolean
}): void {
  const entry = getOrCreateTrackerEntry(args.keys)
  if (!entry) {
    return
  }
  const { rawState, doneStamp, forceUnreadIfUnacknowledged } = args
  if (isInTurnDotState(rawState)) {
    entry.sawInTurn = true
    entry.unread = false
    return
  }
  if (rawState === 'done') {
    if (entry.sawInTurn) {
      entry.sawInTurn = false
      entry.unread = true
      return
    }
    // A passive catalog scan must not acknowledge, so a later unread signal can still mark this completion.
    if (
      forceUnreadIfUnacknowledged &&
      (entry.acknowledgedDoneAt === undefined ||
        (doneStamp !== undefined && doneStamp > entry.acknowledgedDoneAt))
    ) {
      entry.sawInTurn = false
      entry.unread = true
    }
    return
  }
  if (rawState === 'interrupted' || rawState === 'failed') {
    entry.sawInTurn = false
    entry.unread = false
  }
}

function getOrCreateTrackerEntry(keys: readonly string[]): TabCompletionTrackerEntry | null {
  if (keys.length === 0) {
    return null
  }
  let existing: TabCompletionTrackerEntry | undefined
  for (const key of keys) {
    existing = tabCompletionTracker.get(key)
    if (existing) {
      break
    }
  }
  const entry = existing ?? { sawInTurn: false, unread: false }
  for (const key of keys) {
    tabCompletionTracker.set(key, entry)
  }
  return entry
}

export function buildTabCompletionKeys(args: {
  id?: string | null
  terminal?: string | null
  paneKey?: string | null
}): string[] {
  const keys: string[] = []
  if (args.id) {
    keys.push(`tab:${args.id}`)
  }
  if (args.terminal) {
    keys.push(`pty:${args.terminal}`)
  }
  if (args.paneKey) {
    keys.push(`pane:${args.paneKey}`)
  }
  return keys
}

export function resolveTrackedTabCompletionState(args: {
  keys: readonly string[]
  rawState: AgentDotState | undefined
  doneStamp?: number
  isActiveOnScreen?: boolean
  previousCardState?: AgentDotState
}): AgentDotState | undefined {
  const { keys, rawState, doneStamp, isActiveOnScreen, previousCardState } = args
  const entry = getOrCreateTrackerEntry(keys)
  if (!entry) {
    return rawState
  }
  if (
    previousCardState === 'unread' &&
    !entry.sawInTurn &&
    !entry.unread &&
    entry.acknowledgedDoneAt === undefined
  ) {
    entry.unread = true
  }
  if (isInTurnDotState(previousCardState) && rawState === 'done' && isActiveOnScreen === false) {
    entry.sawInTurn = true
  }
  if (isInTurnDotState(rawState)) {
    entry.sawInTurn = true
    entry.unread = false
    return rawState
  }
  if (rawState === 'done') {
    const hasUnacknowledgedCompletion = entry.unread || entry.sawInTurn
    if (isActiveOnScreen === true) {
      entry.sawInTurn = false
      entry.unread = false
      if (doneStamp !== undefined) {
        entry.acknowledgedDoneAt = Math.max(entry.acknowledgedDoneAt ?? 0, doneStamp)
      }
      return 'done'
    }
    if (isActiveOnScreen === false) {
      if (hasUnacknowledgedCompletion) {
        entry.sawInTurn = false
        entry.unread = true
        return 'unread'
      }
      if (doneStamp !== undefined && entry.acknowledgedDoneAt === undefined) {
        entry.acknowledgedDoneAt = doneStamp
      }
      return 'done'
    }
    if (entry.unread) {
      return 'unread'
    }
    if (entry.sawInTurn) {
      entry.sawInTurn = false
      entry.unread = true
      return 'unread'
    }
    if (doneStamp !== undefined && entry.acknowledgedDoneAt === undefined) {
      entry.acknowledgedDoneAt = doneStamp
    }
    return 'done'
  }
  if (rawState === 'interrupted' || rawState === 'failed') {
    entry.sawInTurn = false
    entry.unread = false
  }
  return rawState
}
