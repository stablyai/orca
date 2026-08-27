import type {
  GitHubPRRefreshAlias,
  GitHubPRRefreshCandidate,
  GitHubPRRefreshReason
} from '../../shared/github/pull-request-refresh-types'
import {
  aliasFromCandidate,
  bypassesFreshnessDelay,
  freshRetryAt,
  POST_PUSH_DELAY_MS,
  refreshKey,
  shouldSkipFresh
} from './pr-refresh-candidate-policy'

export type PRRefreshQueueEntry = {
  key: string
  candidate: GitHubPRRefreshCandidate
  aliases: Map<string, GitHubPRRefreshAlias>
  reason: GitHubPRRefreshReason
  priority: number
  dueAt: number
  queuedAt: number
  bypassBackgroundBudget?: boolean
  activeDelayNotified?: boolean
  windowId?: number
}

export type PRRefreshEnqueue = {
  alias: GitHubPRRefreshAlias
  key: string
  dueAt: number
  coalesced: boolean
}

export class PRRefreshQueue {
  private readonly entries = new Map<string, PRRefreshQueueEntry>()
  private order = 0

  constructor(private readonly resetRetryState: (key: string) => void) {}

  get size(): number {
    return this.entries.size
  }

  get(key: string): PRRefreshQueueEntry | undefined {
    return this.entries.get(key)
  }

  set(key: string, entry: PRRefreshQueueEntry): void {
    this.entries.set(key, entry)
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  values(): IterableIterator<PRRefreshQueueEntry> {
    return this.entries.values()
  }

  nextOrder(): number {
    this.order += 1
    return this.order
  }

  aliasCount(key: string): number {
    return this.entries.get(key)?.aliases.size ?? 0
  }

  enqueue(
    candidate: GitHubPRRefreshCandidate,
    reason: GitHubPRRefreshReason,
    priority: number,
    windowId?: number
  ): PRRefreshEnqueue {
    const alias = aliasFromCandidate(candidate)
    const key = refreshKey(candidate)
    const existing = this.entries.get(key)
    const freshDueAt = shouldSkipFresh(candidate, reason) ? freshRetryAt(candidate) : null
    const dueAt = freshDueAt ?? Date.now() + (reason === 'post-push' ? POST_PUSH_DELAY_MS : 0)
    if (!existing) {
      this.entries.set(key, {
        key,
        candidate,
        aliases: new Map([[alias.cacheKey, alias]]),
        reason,
        priority,
        dueAt,
        queuedAt: this.nextOrder(),
        windowId
      })
      return { alias, key, dueAt, coalesced: false }
    }

    existing.aliases.set(alias.cacheKey, alias)
    const shouldPromote =
      priority > existing.priority ||
      reason === 'manual' ||
      (reason === 'active' && existing.reason === 'active') ||
      (priority >= existing.priority && dueAt < existing.dueAt && bypassesFreshnessDelay(reason))
    if (shouldPromote) {
      existing.priority = priority
      existing.reason = reason
      existing.dueAt = Math.min(existing.dueAt, dueAt)
      existing.queuedAt = this.nextOrder()
      existing.activeDelayNotified = false
      existing.candidate = candidate
      existing.windowId = windowId ?? existing.windowId
    } else if (existing.candidate.worktreeId === candidate.worktreeId) {
      existing.candidate = {
        ...existing.candidate,
        cacheKey: candidate.cacheKey,
        branch: candidate.branch,
        currentHeadOid: candidate.currentHeadOid ?? null
      }
    }
    return { alias, key, dueAt, coalesced: true }
  }

  removeInvalidAlias(key: string, alias: GitHubPRRefreshAlias): void {
    const existing = this.entries.get(key)
    if (!existing) {
      return
    }
    existing.aliases.delete(alias.cacheKey)
    const replacement = existing.aliases.values().next().value
    if (!replacement) {
      this.entries.delete(key)
      this.resetRetryState(key)
      return
    }
    if (existing.candidate.cacheKey === alias.cacheKey) {
      existing.candidate = {
        ...existing.candidate,
        cacheKey: replacement.cacheKey,
        branch: replacement.branch,
        worktreeId: replacement.worktreeId,
        currentHeadOid: replacement.currentHeadOid ?? null,
        isArchived: false,
        isBare: false
      }
    }
  }

  pruneWorktreeAliases(worktreeId: string): void {
    for (const [key, entry] of this.entries) {
      let removed = false
      for (const [cacheKey, alias] of entry.aliases) {
        if (alias.worktreeId === worktreeId) {
          entry.aliases.delete(cacheKey)
          removed = true
        }
      }
      if (!removed) {
        continue
      }
      if (entry.aliases.size === 0) {
        this.entries.delete(key)
        this.resetRetryState(key)
        continue
      }
      if (entry.candidate.worktreeId === worktreeId) {
        const replacement = entry.aliases.values().next().value
        if (replacement) {
          entry.candidate = {
            ...entry.candidate,
            cacheKey: replacement.cacheKey,
            branch: replacement.branch,
            worktreeId: replacement.worktreeId,
            currentHeadOid: replacement.currentHeadOid ?? null
          }
        }
      }
    }
  }

  removeInvisibleVisibleEntries(isVisible: (key: string) => boolean): PRRefreshQueueEntry[] {
    const removed: PRRefreshQueueEntry[] = []
    for (const [key, entry] of this.entries) {
      if (entry.reason !== 'visible' || isVisible(key)) {
        continue
      }
      this.entries.delete(key)
      this.resetRetryState(key)
      removed.push(entry)
    }
    return removed
  }

  setVisibleFollowUp(entry: PRRefreshQueueEntry): void {
    const existing = this.entries.get(entry.key)
    if (!existing) {
      this.entries.set(entry.key, entry)
      return
    }
    for (const alias of entry.aliases.values()) {
      existing.aliases.set(alias.cacheKey, alias)
    }
    if (
      bypassesFreshnessDelay(existing.reason) ||
      existing.priority > entry.priority ||
      existing.dueAt <= entry.dueAt
    ) {
      return
    }
    this.entries.set(entry.key, { ...entry, aliases: existing.aliases })
  }

  ordered(
    activeOrder: (a: PRRefreshQueueEntry, b: PRRefreshQueueEntry) => number
  ): PRRefreshQueueEntry[] {
    const now = Date.now()
    return Array.from(this.entries.values()).sort((a, b) => {
      const aReady = a.dueAt <= now
      const bReady = b.dueAt <= now
      if (aReady && bReady) {
        return b.priority - a.priority || activeOrder(a, b) || a.dueAt - b.dueAt
      }
      if (aReady !== bReady) {
        return aReady ? -1 : 1
      }
      return a.dueAt - b.dueAt || b.priority - a.priority
    })
  }
}
