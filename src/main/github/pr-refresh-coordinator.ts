/* eslint-disable max-lines -- Why: the coordinator keeps queueing, pacing, and
renderer broadcast rules together so freshness and rate-limit invariants are
reviewable in one place. */
import { webContents } from 'electron'
import type {
  GitHubPRRefreshAlias,
  GitHubPRRefreshCandidate,
  GitHubPRRefreshEvent,
  GitHubPRRefreshReason,
  GitHubPRRefreshSkippedReason,
  PRRefreshOutcome
} from '../../shared/types'
import { getPRForBranchOutcome } from './client'
import { getRateLimit, noteRateLimitSpend, rateLimitGuard } from './rate-limit'

type QueueEntry = {
  key: string
  candidate: GitHubPRRefreshCandidate
  aliases: Map<string, GitHubPRRefreshAlias>
  reason: GitHubPRRefreshReason
  priority: number
  dueAt: number
  windowId?: number
}

type PRRefreshOutcomeObserver = (
  candidate: GitHubPRRefreshCandidate,
  outcome: PRRefreshOutcome
) => void

const MIN_BACKGROUND_REFRESH_AGE_MS = 60_000
const MERGEABILITY_PENDING_REFRESH_MS = 10_000
const BACKGROUND_BUDGET_WINDOW_MS = 5 * 60_000
const MIN_BACKGROUND_SPACING_MS = 10_000
const BACKGROUND_BUDGET_MAX = 20
const POST_PUSH_DELAY_MS = 2_500
const BACKOFF_BASE_MS = 60_000
const BACKOFF_MAX_MS = 15 * 60_000

let sequence = 0
let draining = false
let drainTimer: ReturnType<typeof setTimeout> | null = null
const queue = new Map<string, QueueEntry>()
const backgroundStarts: number[] = []
const errorBackoff = new Map<string, { failures: number; retryAt: number }>()
let lastBackgroundStartAt = 0
const visibleByWindow = new Map<number, { generation: number; keys: Set<string> }>()
let outcomeObserver: PRRefreshOutcomeObserver | null = null

export function setPRRefreshOutcomeObserver(observer: PRRefreshOutcomeObserver | null): void {
  outcomeObserver = observer
}

function nextSequence(): number {
  sequence += 1
  return sequence
}

function broadcast(event: Omit<GitHubPRRefreshEvent, 'sequence'>, sequenceOverride?: number): void {
  const payload = { ...event, sequence: sequenceOverride ?? nextSequence() } as GitHubPRRefreshEvent
  for (const wc of webContents.getAllWebContents()) {
    if (!wc.isDestroyed()) {
      wc.send('gh:prRefreshEvent', payload)
    }
  }
}

function refreshKey(candidate: GitHubPRRefreshCandidate): string {
  const connectionScope = candidate.connectionId ?? 'local'
  if (typeof candidate.linkedPRNumber === 'number') {
    return `${connectionScope}::${candidate.repoPath}::pr::${candidate.linkedPRNumber}`
  }
  return `${connectionScope}::${candidate.repoPath}::branch::${candidate.branch}`
}

function isVisibleKey(key: string): boolean {
  const liveWindowIds = new Set(
    webContents
      .getAllWebContents()
      .filter((wc) => !wc.isDestroyed())
      .map((wc) => wc.id)
  )
  for (const windowId of Array.from(visibleByWindow.keys())) {
    if (!liveWindowIds.has(windowId)) {
      visibleByWindow.delete(windowId)
    }
  }
  for (const visible of visibleByWindow.values()) {
    if (visible.keys.has(key)) {
      return true
    }
  }
  return false
}

function isManual(reason: GitHubPRRefreshReason): boolean {
  return reason === 'manual'
}

function bypassesFreshnessDelay(reason: GitHubPRRefreshReason): boolean {
  return reason === 'manual' || reason === 'active' || reason === 'post-push'
}

function isBackground(reason: GitHubPRRefreshReason): boolean {
  return reason !== 'manual'
}

function isBudgetedBackground(reason: GitHubPRRefreshReason): boolean {
  return reason === 'visible' || reason === 'swr'
}

function validateCandidate(
  candidate: GitHubPRRefreshCandidate
): GitHubPRRefreshSkippedReason | null {
  if (candidate.repoKind !== 'git') {
    return 'not-git'
  }
  if (candidate.isBare) {
    return 'bare'
  }
  if (candidate.isArchived) {
    return 'archived'
  }
  if (candidate.connectionId && candidate.connectionState === 'disconnected') {
    return 'disconnected'
  }
  if (!candidate.branch && typeof candidate.linkedPRNumber !== 'number') {
    return 'fresh'
  }
  return null
}

function shouldSkipFresh(
  candidate: GitHubPRRefreshCandidate,
  reason: GitHubPRRefreshReason
): boolean {
  if (bypassesFreshnessDelay(reason) || candidate.cachedFetchedAt == null) {
    return false
  }
  return Date.now() - candidate.cachedFetchedAt < refreshIntervalForCandidate(candidate)
}

function shouldBroadcastQueued(reason: GitHubPRRefreshReason, dueAt: number): boolean {
  if (isBudgetedBackground(reason)) {
    return false
  }
  const delay = dueAt - Date.now()
  if (delay <= 0) {
    return false
  }
  return delay <= 5_000
}

function freshRetryAt(candidate: GitHubPRRefreshCandidate): number | null {
  return candidate.cachedFetchedAt == null
    ? null
    : candidate.cachedFetchedAt + refreshIntervalForCandidate(candidate)
}

function aliasFromCandidate(candidate: GitHubPRRefreshCandidate): GitHubPRRefreshAlias {
  return {
    cacheKey: candidate.cacheKey,
    repoId: candidate.repoId,
    repoPath: candidate.repoPath,
    branch: candidate.branch,
    worktreeId: candidate.worktreeId,
    connectionId: candidate.connectionId ?? null,
    linkedPRNumber: candidate.linkedPRNumber ?? null,
    fallbackPRNumber:
      candidate.linkedPRNumber == null ? (candidate.fallbackPRNumber ?? null) : null,
    fallbackPRSource: candidate.linkedPRNumber == null ? (candidate.fallbackPRSource ?? null) : null
  }
}

function visibleCandidateAfterOutcome(
  candidate: GitHubPRRefreshCandidate,
  outcome: PRRefreshOutcome
): GitHubPRRefreshCandidate {
  if (outcome.kind === 'upstream-error') {
    return candidate
  }
  return {
    ...candidate,
    cachedFetchedAt: outcome.fetchedAt,
    cachedHasPR: outcome.kind === 'found',
    cachedPRState: outcome.kind === 'found' ? outcome.pr.state : null,
    cachedChecksStatus: outcome.kind === 'found' ? outcome.pr.checksStatus : null,
    cachedMergeable: outcome.kind === 'found' ? outcome.pr.mergeable : null,
    cachedMergeStateStatus: outcome.kind === 'found' ? (outcome.pr.mergeStateStatus ?? null) : null
  }
}

function setVisibleFollowUp(entry: QueueEntry): void {
  const existing = queue.get(entry.key)
  if (!existing) {
    queue.set(entry.key, entry)
    return
  }

  for (const alias of entry.aliases.values()) {
    existing.aliases.set(alias.cacheKey, alias)
  }

  // Why: a user activation can arrive while a background refresh is awaiting gh.
  // The background follow-up must not overwrite that pending active/manual work.
  if (
    bypassesFreshnessDelay(existing.reason) ||
    existing.priority > entry.priority ||
    existing.dueAt <= entry.dueAt
  ) {
    return
  }

  queue.set(entry.key, {
    ...entry,
    aliases: existing.aliases
  })
}

function removeQueuedAliasForInvalidCandidate(key: string, alias: GitHubPRRefreshAlias): void {
  const existing = queue.get(key)
  if (!existing) {
    return
  }

  existing.aliases.delete(alias.cacheKey)
  const replacementAlias = existing.aliases.values().next().value
  if (!replacementAlias) {
    queue.delete(key)
    errorBackoff.delete(key)
    return
  }

  if (existing.candidate.cacheKey === alias.cacheKey) {
    existing.candidate = {
      ...existing.candidate,
      cacheKey: replacementAlias.cacheKey,
      branch: replacementAlias.branch,
      worktreeId: replacementAlias.worktreeId,
      isArchived: false,
      isBare: false
    }
  }
}

function scheduleVisibleFollowUp(
  key: string,
  candidate: GitHubPRRefreshCandidate,
  outcome: PRRefreshOutcome,
  priority: number,
  aliases: GitHubPRRefreshAlias[],
  windowId?: number
): void {
  if (!isVisibleKey(key)) {
    return
  }
  if (outcome.kind === 'upstream-error') {
    const failures = (errorBackoff.get(key)?.failures ?? 0) + 1
    const retryAt =
      Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 4))
    errorBackoff.set(key, { failures, retryAt })
    setVisibleFollowUp({
      key,
      candidate,
      aliases: new Map(aliases.map((alias) => [alias.cacheKey, alias])),
      reason: 'visible',
      priority,
      dueAt: retryAt,
      windowId
    })
    // Why: this is a delayed retry, not active work; showing it as a spinner
    // makes visible worktrees look stuck until the backoff expires.
    scheduleDrain(retryAt - Date.now())
    return
  }
  errorBackoff.delete(key)
  const followUpCandidate = visibleCandidateAfterOutcome(candidate, outcome)
  const dueAt = freshRetryAt(followUpCandidate) ?? Date.now()
  // Why: coalesced linked-PR refreshes may represent several local branches.
  // Preserve every alias for the next visible follow-up so all cache entries
  // keep receiving periodic updates.
  setVisibleFollowUp({
    key,
    candidate: followUpCandidate,
    aliases: new Map(aliases.map((alias) => [alias.cacheKey, alias])),
    reason: 'visible',
    priority,
    dueAt,
    windowId
  })
  scheduleDrain(Math.max(0, dueAt - Date.now()))
}

function refreshIntervalForCandidate(candidate: GitHubPRRefreshCandidate): number {
  if (candidate.cachedPRState === 'closed' || candidate.cachedPRState === 'merged') {
    return 30 * 60_000
  }
  if (candidate.cachedHasPR === false) {
    return 15 * 60_000
  }
  if (
    candidate.cachedHasPR === true &&
    candidate.cachedPRState === 'open' &&
    candidate.cachedMergeable === 'UNKNOWN' &&
    !hasResolvedMergeStateStatus(candidate.cachedMergeStateStatus)
  ) {
    // Why: GitHub can return transient UNKNOWN mergeability while it computes
    // the PR test merge; visible merge buttons need a prompt follow-up.
    return MERGEABILITY_PENDING_REFRESH_MS
  }
  if (candidate.cachedChecksStatus === 'success') {
    return 10 * 60_000
  }
  if (candidate.cachedChecksStatus === 'failure') {
    return 3 * 60_000
  }
  if (candidate.cachedChecksStatus === 'pending') {
    return 90_000
  }
  return MIN_BACKGROUND_REFRESH_AGE_MS
}

function hasResolvedMergeStateStatus(status: string | null | undefined): boolean {
  return status === 'CLEAN' || status === 'BEHIND' || status === 'BLOCKED'
}

function backgroundRefreshBuckets(): ('core' | 'graphql')[] {
  // Why: branch refreshes prefer REST but can still fall back to `gh pr list`
  // when local head-owner metadata is unavailable. Guard both buckets until the
  // client exposes an exact per-lookup cost plan.
  return ['core', 'graphql']
}

function noteBackgroundStart(): void {
  const now = Date.now()
  lastBackgroundStartAt = now
  backgroundStarts.push(now)
  while (backgroundStarts.length > 0 && now - backgroundStarts[0] > BACKGROUND_BUDGET_WINDOW_MS) {
    backgroundStarts.shift()
  }
}

function nextBudgetDelay(): number {
  const now = Date.now()
  while (backgroundStarts.length > 0 && now - backgroundStarts[0] > BACKGROUND_BUDGET_WINDOW_MS) {
    backgroundStarts.shift()
  }
  const spacingDelay =
    lastBackgroundStartAt > 0
      ? Math.max(0, MIN_BACKGROUND_SPACING_MS - (now - lastBackgroundStartAt))
      : 0
  const windowDelay =
    backgroundStarts.length < BACKGROUND_BUDGET_MAX
      ? 0
      : Math.max(1_000, BACKGROUND_BUDGET_WINDOW_MS - (now - backgroundStarts[0]))
  return Math.max(spacingDelay, windowDelay)
}

function scheduleDrain(delay = 0): void {
  if (drainTimer) {
    clearTimeout(drainTimer)
  }
  drainTimer = setTimeout(() => {
    drainTimer = null
    void drainQueue()
  }, delay)
}

function queuedEntriesByPriority(): QueueEntry[] {
  const now = Date.now()
  return Array.from(queue.values()).sort((a, b) => {
    const aReady = a.dueAt <= now
    const bReady = b.dueAt <= now
    if (aReady && bReady) {
      return b.priority - a.priority || a.dueAt - b.dueAt
    }
    if (aReady !== bReady) {
      return aReady ? -1 : 1
    }
    return a.dueAt - b.dueAt || b.priority - a.priority
  })
}

async function drainQueue(): Promise<void> {
  if (draining) {
    return
  }
  draining = true
  try {
    while (queue.size > 0) {
      const next = queuedEntriesByPriority()[0]
      const waitMs = next.dueAt - Date.now()
      if (waitMs > 0) {
        scheduleDrain(waitMs)
        return
      }

      const budgetDelay = isBudgetedBackground(next.reason) ? nextBudgetDelay() : 0
      if (budgetDelay > 0) {
        scheduleDrain(budgetDelay)
        return
      }

      queue.delete(next.key)
      const aliases = Array.from(next.aliases.values())
      const skippedReason = validateCandidate(next.candidate)
      if (skippedReason) {
        broadcast({ aliases, reason: next.reason, status: 'skipped', skippedReason })
        continue
      }
      if (next.reason === 'visible' && !isVisibleKey(next.key)) {
        errorBackoff.delete(next.key)
        broadcast({ aliases, reason: next.reason, status: 'skipped', skippedReason: 'fresh' })
        continue
      }
      const requestSequence = nextSequence()
      const requestStartedAt = Date.now()
      broadcast(
        { aliases, reason: next.reason, status: 'in-flight', requestStartedAt },
        requestSequence
      )

      if (isBackground(next.reason)) {
        const rateLimit = await getRateLimit()
        if (!rateLimit.ok) {
          const retryAt = Date.now() + 30_000
          queue.set(next.key, { ...next, dueAt: retryAt })
          broadcast({
            aliases,
            reason: next.reason,
            status: 'paused',
            pausedUntil: retryAt,
            skippedReason: 'rate-limit'
          })
          scheduleDrain(30_000)
          continue
        }
        const buckets = backgroundRefreshBuckets()
        const blockedGuard = buckets
          .map((bucket) => rateLimitGuard(bucket))
          .find((guard) => guard.blocked)
        if (blockedGuard?.blocked) {
          const retryAt = blockedGuard.resetAt * 1000
          queue.set(next.key, { ...next, dueAt: retryAt })
          broadcast({
            aliases,
            reason: next.reason,
            status: 'paused',
            pausedUntil: retryAt,
            skippedReason: 'rate-limit'
          })
          scheduleDrain(Math.max(1_000, retryAt - Date.now()))
          continue
        }
        if (isBudgetedBackground(next.reason)) {
          noteBackgroundStart()
        }
        for (const bucket of buckets) {
          noteRateLimitSpend(bucket)
        }
      }

      const outcome = await getPRForBranchOutcome(
        next.candidate.repoPath,
        next.candidate.branch,
        next.candidate.linkedPRNumber ?? null,
        next.candidate.connectionId ?? null,
        next.candidate.linkedPRNumber == null ? (next.candidate.fallbackPRNumber ?? null) : null
      )
      outcomeObserver?.(next.candidate, outcome)
      broadcast({ aliases, reason: next.reason, outcome, requestStartedAt }, requestSequence)
      scheduleVisibleFollowUp(
        next.key,
        next.candidate,
        outcome,
        next.priority,
        aliases,
        next.windowId
      )
    }
  } finally {
    draining = false
  }
}

export function enqueuePRRefresh(
  candidate: GitHubPRRefreshCandidate,
  reason: GitHubPRRefreshReason,
  priority = 0,
  windowId?: number
): void {
  const alias = aliasFromCandidate(candidate)
  const key = refreshKey(candidate)
  const skippedReason = validateCandidate(candidate)
  if (skippedReason) {
    removeQueuedAliasForInvalidCandidate(key, alias)
    broadcast({
      aliases: [alias],
      reason,
      status: 'skipped',
      skippedReason
    })
    return
  }

  const existing = queue.get(key)
  const freshDueAt = shouldSkipFresh(candidate, reason) ? freshRetryAt(candidate) : null
  const dueAt = freshDueAt ?? Date.now() + (reason === 'post-push' ? POST_PUSH_DELAY_MS : 0)
  if (existing) {
    existing.aliases.set(alias.cacheKey, alias)
    const shouldPromoteExisting =
      priority > existing.priority ||
      isManual(reason) ||
      (priority >= existing.priority && dueAt < existing.dueAt && bypassesFreshnessDelay(reason))
    if (shouldPromoteExisting) {
      existing.priority = priority
      existing.reason = reason
      existing.dueAt = Math.min(existing.dueAt, dueAt)
      existing.candidate = candidate
      existing.windowId = windowId ?? existing.windowId
    }
  } else {
    queue.set(key, {
      key,
      candidate,
      aliases: new Map([[alias.cacheKey, alias]]),
      reason,
      priority,
      dueAt,
      windowId
    })
  }
  // Why: visible/SWR refreshes are background maintenance and may sit behind
  // the budget queue. Only user/action-driven queueing should surface in UI.
  if (shouldBroadcastQueued(reason, dueAt)) {
    broadcast({ aliases: [alias], reason, status: 'queued' })
  }
  scheduleDrain()
}

export function reportVisiblePRRefreshCandidates(
  candidates: GitHubPRRefreshCandidate[],
  generation: number,
  windowId: number
): void {
  const existingVisible = visibleByWindow.get(windowId)
  if (existingVisible && generation < existingVisible.generation) {
    return
  }
  visibleByWindow.set(windowId, { generation, keys: new Set(candidates.map(refreshKey)) })
  for (const [key, entry] of queue) {
    if (entry.reason === 'visible' && !isVisibleKey(key)) {
      queue.delete(key)
      errorBackoff.delete(key)
      broadcast({
        aliases: Array.from(entry.aliases.values()),
        reason: 'visible',
        status: 'skipped',
        skippedReason: 'fresh'
      })
    }
  }
  for (const candidate of candidates) {
    enqueuePRRefresh(candidate, 'visible', 40, windowId)
  }
}

export async function refreshPRNow(candidate: GitHubPRRefreshCandidate): Promise<PRRefreshOutcome> {
  const alias = aliasFromCandidate(candidate)
  const key = refreshKey(candidate)
  const existing = queue.get(key)
  const aliasMap = new Map(existing ? existing.aliases : [])
  aliasMap.set(alias.cacheKey, alias)
  const aliases = Array.from(aliasMap.values())
  const skippedReason = validateCandidate(candidate)
  if (skippedReason) {
    removeQueuedAliasForInvalidCandidate(key, alias)
    const outcome: PRRefreshOutcome = {
      kind: 'upstream-error',
      errorType: 'unknown',
      message: `Cannot refresh PR for this worktree: ${skippedReason}`,
      fetchedAt: Date.now()
    }
    broadcast({ aliases: [alias], reason: 'manual', status: 'skipped', skippedReason })
    return outcome
  }

  queue.delete(key)
  const requestSequence = nextSequence()
  const requestStartedAt = Date.now()
  broadcast({ aliases, reason: 'manual', status: 'in-flight', requestStartedAt }, requestSequence)
  const outcome = await getPRForBranchOutcome(
    candidate.repoPath,
    candidate.branch,
    candidate.linkedPRNumber ?? null,
    candidate.connectionId ?? null,
    candidate.linkedPRNumber == null ? (candidate.fallbackPRNumber ?? null) : null
  )
  outcomeObserver?.(candidate, outcome)
  broadcast({ aliases, reason: 'manual', outcome, requestStartedAt }, requestSequence)
  scheduleVisibleFollowUp(key, candidate, outcome, 40, aliases)
  return outcome
}
