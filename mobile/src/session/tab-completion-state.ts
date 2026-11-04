import type { AgentDotState } from '../worktree/agent-row-display'

type TabCompletionTrackerEntry = {
  sawInTurn: boolean
  catalogSawInTurn?: boolean
  unread: boolean
  acknowledgedDoneAt?: number
}

const tabCompletionTracker = new Map<string, TabCompletionTrackerEntry>()
const unreadWorktreeIds = new Set<string>()
const latchedUnreadTabKeys = new Set<string>()
const tabCompletionListeners = new Set<() => void>()

export function subscribeTabCompletionState(listener: () => void): () => void {
  tabCompletionListeners.add(listener)
  return () => {
    tabCompletionListeners.delete(listener)
  }
}

export function notifyTabCompletionStateChanged(): void {
  tabCompletionListeners.forEach((listener) => listener())
}

export function clearTabCompletionEntriesForTests(): void {
  tabCompletionTracker.clear()
  unreadWorktreeIds.clear()
  latchedUnreadTabKeys.clear()
  tabCompletionListeners.clear()
}

export function isInTurnDotState(state: AgentDotState | null | undefined): boolean {
  return state === 'working' || state === 'monitoring' || state === 'waiting' || state === 'blocked'
}

export function markWorktreeUnreadForTabCompletion(worktreeId: string | null | undefined): void {
  if (worktreeId && !unreadWorktreeIds.has(worktreeId)) {
    unreadWorktreeIds.add(worktreeId)
    notifyTabCompletionStateChanged()
  }
}

export function hasPendingWorktreeUnreadForTabCompletion(
  worktreeId: string | null | undefined
): boolean {
  return typeof worktreeId === 'string' && unreadWorktreeIds.has(worktreeId)
}

export function consumeWorktreeUnreadForTabCompletion(
  worktreeId: string | null | undefined
): boolean {
  const deleted = Boolean(worktreeId && unreadWorktreeIds.delete(worktreeId))
  if (deleted) {
    notifyTabCompletionStateChanged()
  }
  return deleted
}

export function setLatchedUnreadTabKeys(keys: readonly string[]): void {
  latchedUnreadTabKeys.clear()
  keys.forEach((key) => latchedUnreadTabKeys.add(key))
  notifyTabCompletionStateChanged()
}

export function clearLatchedUnreadTabKeys(): void {
  if (latchedUnreadTabKeys.size > 0) {
    latchedUnreadTabKeys.clear()
    notifyTabCompletionStateChanged()
  }
}

export function restoreLatchedUnreadTabKeys(): void {
  if (latchedUnreadTabKeys.size === 0) {
    return
  }
  const entry = getOrCreateTrackerEntry([...latchedUnreadTabKeys])
  latchedUnreadTabKeys.clear()
  if (entry) {
    entry.unread = true
  }
  notifyTabCompletionStateChanged()
}

export function acknowledgeSupersededCatalogInTurn(
  keys: readonly string[],
  doneStamp?: number
): void {
  const entry = getOrCreateTrackerEntry(keys)
  if (!entry) {
    return
  }
  entry.catalogSawInTurn = false
  if (!entry.unread && !entry.sawInTurn && doneStamp !== undefined && !entry.acknowledgedDoneAt) {
    entry.acknowledgedDoneAt = doneStamp
  }
}

export function hasUnacknowledgedTabCompletion(
  keys: readonly string[],
  rawState: AgentDotState | undefined
): boolean {
  return (
    rawState === 'done' &&
    keys.some((key) => {
      const entry = tabCompletionTracker.get(key)
      return Boolean(entry?.unread || entry?.sawInTurn)
    })
  )
}

export function hasHostUnacknowledgedTabCompletion(
  keys: readonly string[],
  rawState: AgentDotState | undefined
): boolean {
  return (
    rawState === 'done' &&
    keys.some((key) => {
      const entry = tabCompletionTracker.get(key)
      return latchedUnreadTabKeys.has(key) || Boolean(entry?.unread || entry?.sawInTurn)
    })
  )
}

export function isTabCompletionAcknowledged(keys: readonly string[], doneStamp?: number): boolean {
  if (keys.some((key) => latchedUnreadTabKeys.has(key))) {
    return false
  }
  return keys.some((key) => {
    const entry = tabCompletionTracker.get(key)
    return Boolean(
      entry &&
      !entry.unread &&
      !entry.sawInTurn &&
      entry.acknowledgedDoneAt !== undefined &&
      (doneStamp === undefined || entry.acknowledgedDoneAt >= doneStamp)
    )
  })
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
  const prevUnread = entry.unread
  const { rawState, doneStamp, forceUnreadIfUnacknowledged } = args
  if (isInTurnDotState(rawState)) {
    entry.catalogSawInTurn = true
    entry.unread = false
  } else if (rawState === 'done') {
    if (
      entry.catalogSawInTurn ||
      entry.sawInTurn ||
      (forceUnreadIfUnacknowledged &&
        (entry.acknowledgedDoneAt === undefined ||
          (doneStamp !== undefined && doneStamp > entry.acknowledgedDoneAt)))
    ) {
      entry.catalogSawInTurn = false
      entry.sawInTurn = false
      entry.unread = true
    }
  } else if (rawState === 'interrupted' || rawState === 'failed') {
    entry.catalogSawInTurn = false
    entry.sawInTurn = false
    entry.unread = false
  }
  if (prevUnread !== entry.unread) {
    notifyTabCompletionStateChanged()
  }
}

function getOrCreateTrackerEntry(keys: readonly string[]): TabCompletionTrackerEntry | null {
  if (keys.length === 0) {
    return null
  }
  const existing = Array.from(
    new Set(
      keys
        .map((key) => tabCompletionTracker.get(key))
        .filter((item): item is TabCompletionTrackerEntry => Boolean(item))
    )
  )
  let entry: TabCompletionTrackerEntry
  if (existing.length === 0) {
    entry = { sawInTurn: false, unread: false }
  } else if (existing.length === 1) {
    entry = existing[0]
  } else {
    const unread = existing.some((item) => item.unread)
    const sawInTurn = existing.some((item) => item.sawInTurn)
    const catalogSawInTurn = existing.some((item) => item.catalogSawInTurn)
    const acks = existing
      .map((item) => item.acknowledgedDoneAt)
      .filter((stamp): stamp is number => stamp !== undefined)
    entry = {
      sawInTurn,
      ...(catalogSawInTurn ? { catalogSawInTurn: true } : {}),
      unread,
      ...(!unread && !sawInTurn && acks.length > 0 ? { acknowledgedDoneAt: Math.max(...acks) } : {})
    }
  }
  keys.forEach((key) => tabCompletionTracker.set(key, entry))
  return entry
}

export function buildTabCompletionKeys(args: {
  id?: string | null
  terminal?: string | null
  paneKey?: string | null
  sessionId?: string | null
}): string[] {
  const keys: string[] = []
  const sid =
    args.sessionId ||
    (args.id?.startsWith('agent-session:')
      ? args.id.slice('agent-session:'.length)
      : args.id?.startsWith('structured-agent-session-')
        ? args.id.slice('structured-agent-session-'.length)
        : null)
  if (args.id) {
    keys.push(`tab:${args.id}`)
  }
  if (sid) {
    keys.push(`session:${sid}`, `tab:agent-session:${sid}`, `tab:structured-agent-session-${sid}`)
  }
  if (args.terminal) {
    keys.push(`pty:${args.terminal}`)
  }
  if (args.paneKey) {
    keys.push(`pane:${args.paneKey}`)
  }
  return Array.from(new Set(keys))
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
  const prevUnread = entry.unread
  const prevAck = entry.acknowledgedDoneAt
  const finish = (result: AgentDotState | undefined): AgentDotState | undefined => {
    if (prevUnread !== entry.unread || prevAck !== entry.acknowledgedDoneAt) {
      notifyTabCompletionStateChanged()
    }
    return result
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
    return finish(rawState)
  }
  if (rawState === 'done') {
    entry.catalogSawInTurn = false
    if (isActiveOnScreen === true) {
      entry.sawInTurn = false
      entry.unread = false
      if (doneStamp !== undefined) {
        entry.acknowledgedDoneAt = Math.max(entry.acknowledgedDoneAt ?? 0, doneStamp)
      }
      return finish('done')
    }
    if (entry.unread || entry.sawInTurn) {
      entry.sawInTurn = false
      entry.unread = true
      return finish('unread')
    }
    if (doneStamp !== undefined && entry.acknowledgedDoneAt === undefined) {
      entry.acknowledgedDoneAt = doneStamp
    }
    return finish('done')
  }
  if (rawState === 'interrupted' || rawState === 'failed') {
    entry.catalogSawInTurn = false
    entry.sawInTurn = false
    entry.unread = false
  }
  return finish(rawState)
}
