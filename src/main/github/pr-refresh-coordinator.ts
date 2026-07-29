/* eslint-disable max-lines -- Why: queueing, pacing, and broadcast rules stay together so freshness and rate-limit invariants are reviewable in one place. */
import { webContents } from 'electron'
import type {
  GitHubPRRefreshAlias,
  GitHubPRRefreshCandidate,
  GitHubPRRefreshEvent,
  GitHubPRRefreshReason,
  GitHubPRRefreshSkippedReason,
  PRRefreshOutcome
} from '../../shared/types'
import { getPRForBranchOutcome, type GitHubPRBranchLookupOptions } from './client'
import { getOriginGitHubApiRepository } from './github-api-repository'
import { ghRepoExecOptions, githubRepoContext } from './gh-utils'
import {
  getRateLimit,
  noteRepositoryRateLimitSpend,
  repositoryRateLimitGuard,
  spendsSharedGitHubComQuota
} from './rate-limit'
import { recordCoalescedCrashBreadcrumb } from '../crash-reporting/crash-breadcrumb-store'
import { sendToTrustedUIRenderer } from '../ipc/ui'

type QueueEntry = {
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

type PRRefreshOutcomeObserver = (
  candidate: GitHubPRRefreshCandidate,
  outcome: PRRefreshOutcome
) => void

type PRBranchLookupCandidate = Pick<
  GitHubPRRefreshCandidate,
  'localGitOptions' | 'linkedPRNumber' | 'fallbackPRNumber' | 'fallbackPRSource' | 'currentHeadOid'
>

function shouldAcceptMergedFallbackPR(candidate: PRBranchLookupCandidate): boolean {
  return (
    candidate.linkedPRNumber == null &&
    candidate.fallbackPRNumber != null &&
    candidate.fallbackPRSource != null
  )
}

function hostedReviewOptionArgs(
  candidate: PRBranchLookupCandidate
): [] | [GitHubPRBranchLookupOptions] {
  const options: GitHubPRBranchLookupOptions = {}
  if (candidate.localGitOptions?.wslDistro) {
    options.localGitExecOptions = { wslDistro: candidate.localGitOptions.wslDistro }
  }
  if (shouldAcceptMergedFallbackPR(candidate)) {
    options.acceptMergedFallbackPR = true
  }
  if (typeof candidate.currentHeadOid === 'string' && candidate.currentHeadOid.trim().length > 0) {
    options.currentHeadOid = candidate.currentHeadOid.trim()
  }
  return Object.keys(options).length > 0 ? [options] : []
}

const MIN_BACKGROUND_REFRESH_AGE_MS = 60_000
const MERGEABILITY_PENDING_REFRESH_MS = 10_000
const MANUAL_MERGEABILITY_PENDING_REFRESH_MS = 2_500
const BACKGROUND_BUDGET_WINDOW_MS = 5 * 60_000
const MIN_BACKGROUND_SPACING_MS = 10_000
const BACKGROUND_BUDGET_MAX = 20
const POST_PUSH_DELAY_MS = 2_500
const BACKOFF_BASE_MS = 60_000
const BACKOFF_MAX_MS = 15 * 60_000
const DIAGNOSTIC_BREADCRUMB_MIN_INTERVAL_MS = 30_000
const ACTIVE_BURST_WINDOW_MS = 30_000
const ACTIVE_BURST_MAX = 3

let sequence = 0
let queueOrder = 0
let draining = false
let drainTimer: ReturnType<typeof setTimeout> | null = null
const queue = new Map<string, QueueEntry>()
const backgroundStarts: number[] = []
const activeStartsByScope = new Map<string, number[]>()
const errorBackoff = new Map<string, { failures: number; retryAt: number }>()
// Per-key manual-retry cooldown (secondary rate-limit Retry-After); refreshPRNow refuses manual retry until this time so a stale renderer can't bypass it.
const manualRetryGates = new Map<string, number>()
let lastBackgroundStartAt = 0

/**
 * Track (or clear) the manual-retry cooldown for a key from a broadcast outcome.
 * Only a rate-limit outcome carrying `retryDisabledUntil` sets a gate; any other settled outcome clears it.
 */
function noteManualRetryGate(key: string, outcome: PRRefreshOutcome): void {
  if (outcome.kind === 'upstream-error' && outcome.retryDisabledUntil !== undefined) {
    manualRetryGates.set(key, outcome.retryDisabledUntil)
  } else {
    manualRetryGates.delete(key)
  }
}

/** Reset all per-key retry state (backoff + manual cooldown) when a key resets. */
function resetKeyRetryState(key: string): void {
  errorBackoff.delete(key)
  manualRetryGates.delete(key)
}
const visibleByWindow = new Map<number, { generation: number; keys: Set<string> }>()
let outcomeObserver: PRRefreshOutcomeObserver | null = null
const diagnosticsCounters = {
  enqueued: 0,
  coalesced: 0,
  skipped: 0,
  backgroundPauses: 0
}

export function setPRRefreshOutcomeObserver(observer: PRRefreshOutcomeObserver | null): void {
  outcomeObserver = observer
}

function removeInvisibleVisibleRefreshes(): void {
  for (const [key, entry] of queue) {
    if (entry.reason === 'visible' && !isVisibleKey(key)) {
      queue.delete(key)
      resetKeyRetryState(key)
      broadcast({
        aliases: Array.from(entry.aliases.values()),
        reason: 'visible',
        status: 'skipped',
        skippedReason: 'fresh'
      })
    }
  }
}

function recordPRRefreshQueueDiagnostic(
  event: 'enqueued' | 'coalesced' | 'skipped' | 'background-pause',
  reason: GitHubPRRefreshReason,
  skippedReason?: GitHubPRRefreshSkippedReason
): void {
  recordCoalescedCrashBreadcrumb({
    name: 'pr_refresh_queue',
    coalesceKey: `pr-refresh-queue:${event}:${reason}:${skippedReason ?? ''}`,
    minIntervalMs: DIAGNOSTIC_BREADCRUMB_MIN_INTERVAL_MS,
    data: {
      event,
      reason,
      ...(skippedReason ? { skippedReason } : {}),
      enqueued: diagnosticsCounters.enqueued,
      coalesced: diagnosticsCounters.coalesced,
      skipped: diagnosticsCounters.skipped,
      backgroundPauses: diagnosticsCounters.backgroundPauses
    }
  })
}

function clearActiveBurstWindow(windowId: number): void {
  const windowPrefix = `${windowId}::`
  for (const scope of Array.from(activeStartsByScope.keys())) {
    if (scope.startsWith(windowPrefix)) {
      activeStartsByScope.delete(scope)
    }
  }
}

export function clearVisiblePRRefreshWindow(windowId: number): void {
  const hadVisibleRefreshes = visibleByWindow.delete(windowId)
  clearActiveBurstWindow(windowId)
  if (hadVisibleRefreshes) {
    // Why: visible follow-ups are owned by the reporting renderer; if its WebContents is destroyed, no later visibility report arrives.
    removeInvisibleVisibleRefreshes()
  }
}

/**
 * Drop a removed worktree's aliases from every queue entry.
 *
 * Why: aliases are otherwise only pruned when a candidate is re-enqueued as invalid, so churning worktrees grow these maps unbounded (OOM creep).
 */
export function pruneWorktreePRRefreshAliases(worktreeId: string): void {
  for (const [key, entry] of queue) {
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
    // No aliases left means no worktree still cares about this refresh.
    if (entry.aliases.size === 0) {
      queue.delete(key)
      resetKeyRetryState(key)
      continue
    }
    // Keep the entry alive but replace its representative so it isn't a dangling reference to the removed worktree.
    if (entry.candidate.worktreeId === worktreeId) {
      const replacementAlias = entry.aliases.values().next().value
      if (replacementAlias) {
        entry.candidate = {
          ...entry.candidate,
          cacheKey: replacementAlias.cacheKey,
          branch: replacementAlias.branch,
          worktreeId: replacementAlias.worktreeId,
          // Why: the probe now represents the replacement worktree, so use its head — else the removed worktree's link never clears.
          currentHeadOid: replacementAlias.currentHeadOid ?? null
        }
      }
    }
  }
}

function nextSequence(): number {
  sequence += 1
  return sequence
}

function nextQueueOrder(): number {
  queueOrder += 1
  return queueOrder
}

function broadcast(event: Omit<GitHubPRRefreshEvent, 'sequence'>, sequenceOverride?: number): void {
  const payload = { ...event, sequence: sequenceOverride ?? nextSequence() } as GitHubPRRefreshEvent
  sendToTrustedUIRenderer('gh:prRefreshEvent', payload)
}

function refreshKey(candidate: GitHubPRRefreshCandidate): string {
  const connectionScope = candidate.connectionId ?? 'local'
  const runtimeScope = candidate.connectionId
    ? 'remote'
    : `runtime:${candidate.localGitOptions?.wslDistro ? `wsl:${candidate.localGitOptions.wslDistro}` : 'host'}`
  if (typeof candidate.linkedPRNumber === 'number') {
    return `${connectionScope}::${runtimeScope}::${candidate.repoPath}::pr::${candidate.linkedPRNumber}`
  }
  return `${connectionScope}::${runtimeScope}::${candidate.repoPath}::branch::${candidate.branch}`
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

function isBudgetedQueueEntry(entry: QueueEntry): boolean {
  return isBudgetedBackground(entry.reason) && entry.bypassBackgroundBudget !== true
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
    currentHeadOid: candidate.currentHeadOid ?? null,
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

  // Why: a user activation can arrive while a background refresh awaits gh; the follow-up must not overwrite that pending active/manual work.
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
    resetKeyRetryState(key)
    return
  }

  if (existing.candidate.cacheKey === alias.cacheKey) {
    existing.candidate = {
      ...existing.candidate,
      cacheKey: replacementAlias.cacheKey,
      branch: replacementAlias.branch,
      worktreeId: replacementAlias.worktreeId,
      // Why: the probe now represents the replacement worktree, so use its head — else the survivor's link never clears.
      currentHeadOid: replacementAlias.currentHeadOid ?? null,
      isArchived: false,
      isBare: false
    }
  }
}

/**
 * Advances the visible-key error backoff and returns the earliest retry time.
 * Why: only visible keys auto-retry, so callers must gate on `isVisibleKey` first.
 */
function nextVisibleErrorRetryAt(key: string): number {
  const failures = (errorBackoff.get(key)?.failures ?? 0) + 1
  const retryAt =
    Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 4))
  errorBackoff.set(key, { failures, retryAt })
  return retryAt
}

/**
 * Stamps the auto-retry time onto an error outcome before broadcast.
 * Why: sets only `nextAutoRetryAt`, never `retryDisabledUntil` — that disables *manual* Retry and is reserved for a real rate-limit gate.
 */
function withErrorSchedule(outcome: PRRefreshOutcome, retryAt: number): PRRefreshOutcome {
  if (outcome.kind !== 'upstream-error') {
    return outcome
  }
  // Why: honor a real Retry-After cooldown the client stamped (`retryDisabledUntil`) so we don't auto-retry into an active secondary rate limit.
  const cooldownUntil = outcome.retryDisabledUntil
  return {
    ...outcome,
    nextAutoRetryAt: cooldownUntil !== undefined ? Math.max(retryAt, cooldownUntil) : retryAt
  }
}

function scheduleVisibleFollowUp(
  key: string,
  candidate: GitHubPRRefreshCandidate,
  outcome: PRRefreshOutcome,
  priority: number,
  aliases: GitHubPRRefreshAlias[],
  windowId?: number,
  options?: { pendingMergeabilityDelayMs?: number; plannedRetryAt?: number }
): void {
  if (!isVisibleKey(key)) {
    // Why: manual/active refreshes can remove the queued visible retry after its owner window is gone, orphaning the backoff.
    resetKeyRetryState(key)
    return
  }
  if (outcome.kind === 'upstream-error') {
    // Why: reuse the retry time already computed for the broadcast so the same failure isn't counted twice against the backoff.
    const retryAt = options?.plannedRetryAt ?? nextVisibleErrorRetryAt(key)
    setVisibleFollowUp({
      key,
      candidate,
      aliases: new Map(aliases.map((alias) => [alias.cacheKey, alias])),
      reason: 'visible',
      priority,
      dueAt: retryAt,
      queuedAt: nextQueueOrder(),
      windowId
    })
    // Why: this is a delayed retry, not active work; a spinner would make visible worktrees look stuck until backoff expires.
    scheduleDrain(retryAt - Date.now())
    return
  }
  resetKeyRetryState(key)
  const followUpCandidate = visibleCandidateAfterOutcome(candidate, outcome)
  const regularDueAt = freshRetryAt(followUpCandidate) ?? Date.now()
  const pendingMergeabilityDueAt =
    options?.pendingMergeabilityDelayMs !== undefined && isMergeabilityPendingOutcome(outcome)
      ? outcome.fetchedAt + options.pendingMergeabilityDelayMs
      : null
  const dueAt =
    pendingMergeabilityDueAt === null
      ? regularDueAt
      : Math.min(regularDueAt, pendingMergeabilityDueAt)
  // Why: a coalesced linked-PR refresh may represent several branches; preserve every alias so all cache entries keep getting updates.
  setVisibleFollowUp({
    key,
    candidate: followUpCandidate,
    aliases: new Map(aliases.map((alias) => [alias.cacheKey, alias])),
    reason: 'visible',
    priority,
    dueAt,
    queuedAt: nextQueueOrder(),
    // Why: this manual one-shot fixes GitHub's transient UNKNOWN state; visible spacing would delay it past the prompt retry window.
    bypassBackgroundBudget: pendingMergeabilityDueAt !== null,
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
    // Why: GitHub returns transient UNKNOWN mergeability while computing the test merge; visible merge buttons need a prompt follow-up.
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

function isMergeabilityPendingOutcome(outcome: PRRefreshOutcome): boolean {
  return (
    outcome.kind === 'found' &&
    outcome.pr.state === 'open' &&
    outcome.pr.mergeable === 'UNKNOWN' &&
    !hasResolvedMergeStateStatus(outcome.pr.mergeStateStatus)
  )
}

function backgroundRefreshBuckets(): ('core' | 'graphql')[] {
  // Why: branch refreshes prefer REST but can fall back to `gh pr list`, so guard both buckets until the client exposes a per-lookup cost plan.
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

function activeBurstScope(entry: QueueEntry): string {
  const runtimeScope = entry.candidate.connectionId
    ? `ssh:${entry.candidate.connectionId}`
    : `local:${entry.candidate.localGitOptions?.wslDistro ?? 'host'}`
  return `${entry.windowId ?? 'global'}::${runtimeScope}`
}

function pruneActiveStarts(scope: string, now: number): number[] {
  const activeStarts = activeStartsByScope.get(scope) ?? []
  while (activeStarts.length > 0 && now - activeStarts[0] >= ACTIVE_BURST_WINDOW_MS) {
    activeStarts.shift()
  }
  if (activeStarts.length === 0) {
    activeStartsByScope.delete(scope)
  } else {
    activeStartsByScope.set(scope, activeStarts)
  }
  return activeStarts
}

function nextActiveBurstDelay(entry: QueueEntry): number {
  const now = Date.now()
  const activeStarts = pruneActiveStarts(activeBurstScope(entry), now)
  if (activeStarts.length < ACTIVE_BURST_MAX) {
    return 0
  }
  return Math.max(1, ACTIVE_BURST_WINDOW_MS - (now - activeStarts[0]))
}

function noteActiveStart(entry: QueueEntry): void {
  const now = Date.now()
  const scope = activeBurstScope(entry)
  const activeStarts = pruneActiveStarts(scope, now)
  activeStarts.push(now)
  activeStartsByScope.set(scope, activeStarts)
}

function activeOrder(a: QueueEntry, b: QueueEntry): number {
  if (a.reason !== 'active' || b.reason !== 'active') {
    return 0
  }
  if (activeBurstScope(a) !== activeBurstScope(b)) {
    return 0
  }
  // Why: refresh the worktree the user lands on before stale transient selections in the same window/runtime scope.
  return b.queuedAt - a.queuedAt
}

function entryDelay(entry: QueueEntry): number {
  const activeBurstDelay = entry.reason === 'active' ? nextActiveBurstDelay(entry) : 0
  if (activeBurstDelay > 0) {
    return activeBurstDelay
  }
  return isBudgetedQueueEntry(entry) ? nextBudgetDelay() : 0
}

function isActiveBurstDelayed(entry: QueueEntry): boolean {
  return entry.reason === 'active' && nextActiveBurstDelay(entry) > 0
}

function nextQueuedWakeDelay(excludedKey: string): number | null {
  const now = Date.now()
  let nextDelay = Number.POSITIVE_INFINITY
  for (const entry of queue.values()) {
    if (entry.key === excludedKey) {
      continue
    }
    const delay = entry.dueAt > now ? entry.dueAt - now : entryDelay(entry)
    nextDelay = Math.min(nextDelay, delay)
  }
  return Number.isFinite(nextDelay) ? Math.max(0, nextDelay) : null
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
      return b.priority - a.priority || activeOrder(a, b) || a.dueAt - b.dueAt
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
      let next = queuedEntriesByPriority()[0]
      const waitMs = next.dueAt - Date.now()
      if (waitMs > 0) {
        scheduleDrain(waitMs)
        return
      }

      let delay = entryDelay(next)
      if (delay > 0) {
        const runnable = queuedEntriesByPriority().find(
          (entry) => entry.dueAt <= Date.now() && entryDelay(entry) === 0
        )
        if (runnable && runnable.key !== next.key) {
          next = runnable
          delay = 0
        } else {
          if (isActiveBurstDelayed(next) && !next.activeDelayNotified) {
            next.activeDelayNotified = true
            broadcast({
              aliases: Array.from(next.aliases.values()),
              reason: next.reason,
              status: 'queued'
            })
          }
          if (isBudgetedQueueEntry(next) && nextBudgetDelay() > 0) {
            diagnosticsCounters.backgroundPauses += 1
            recordPRRefreshQueueDiagnostic('background-pause', next.reason)
          }
          scheduleDrain(Math.min(delay, nextQueuedWakeDelay(next.key) ?? delay))
          return
        }
      }

      queue.delete(next.key)
      const aliases = Array.from(next.aliases.values())
      const skippedReason = validateCandidate(next.candidate)
      if (skippedReason) {
        diagnosticsCounters.skipped += 1
        recordPRRefreshQueueDiagnostic('skipped', next.reason, skippedReason)
        broadcast({ aliases, reason: next.reason, status: 'skipped', skippedReason })
        continue
      }
      if (next.reason === 'visible' && !isVisibleKey(next.key)) {
        resetKeyRetryState(next.key)
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
        const executionOptions = ghRepoExecOptions(
          githubRepoContext(
            next.candidate.repoPath,
            next.candidate.connectionId,
            next.candidate.localGitOptions
          )
        )
        const repository = await getOriginGitHubApiRepository(
          next.candidate.repoPath,
          next.candidate.connectionId,
          executionOptions
        )
        // Why: only native github.com uses the singleton snapshot; scoped breakers protect GHES and WSL.
        if (spendsSharedGitHubComQuota(repository, executionOptions)) {
          // Why: the probe only warms the cache, so failures must fail open (#7553).
          await getRateLimit()
        }
        const buckets = backgroundRefreshBuckets()
        const blockedGuard = buckets
          .map((bucket) => repositoryRateLimitGuard(repository, bucket, executionOptions))
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
        if (isBudgetedQueueEntry(next)) {
          noteBackgroundStart()
        }
        if (next.reason === 'active') {
          // Why: tab/worktree churn can enqueue many distinct active refreshes that each probe local Git.
          noteActiveStart(next)
        }
        for (const bucket of buckets) {
          noteRepositoryRateLimitSpend(repository, bucket, 1, executionOptions)
        }
      }

      const outcome = await getPRForBranchOutcome(
        next.candidate.repoPath,
        next.candidate.branch,
        next.candidate.linkedPRNumber ?? null,
        next.candidate.connectionId ?? null,
        next.candidate.linkedPRNumber == null ? (next.candidate.fallbackPRNumber ?? null) : null,
        ...hostedReviewOptionArgs(next.candidate)
      )
      // Why: compute the retry schedule before broadcasting so the outcome and its follow-up share one timing; only visible keys auto-retry.
      let plannedRetryAt: number | undefined
      let broadcastOutcome = outcome
      if (outcome.kind === 'upstream-error' && isVisibleKey(next.key)) {
        plannedRetryAt = nextVisibleErrorRetryAt(next.key)
        broadcastOutcome = withErrorSchedule(outcome, plannedRetryAt)
      }
      outcomeObserver?.(next.candidate, outcome)
      noteManualRetryGate(next.key, broadcastOutcome)
      broadcast(
        { aliases, reason: next.reason, outcome: broadcastOutcome, requestStartedAt },
        requestSequence
      )
      scheduleVisibleFollowUp(
        next.key,
        next.candidate,
        outcome,
        next.priority,
        aliases,
        next.windowId,
        {
          plannedRetryAt
        }
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
    diagnosticsCounters.skipped += 1
    recordPRRefreshQueueDiagnostic('skipped', reason, skippedReason)
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
    diagnosticsCounters.coalesced += 1
    recordPRRefreshQueueDiagnostic('coalesced', reason)
    const shouldPromoteExisting =
      priority > existing.priority ||
      isManual(reason) ||
      (reason === 'active' && existing.reason === 'active') ||
      (priority >= existing.priority && dueAt < existing.dueAt && bypassesFreshnessDelay(reason))
    if (shouldPromoteExisting) {
      existing.priority = priority
      existing.reason = reason
      existing.dueAt = Math.min(existing.dueAt, dueAt)
      existing.queuedAt = nextQueueOrder()
      existing.activeDelayNotified = false
      existing.candidate = candidate
      existing.windowId = windowId ?? existing.windowId
    } else if (existing.candidate.worktreeId === candidate.worktreeId) {
      // Why: the representative drives the probe head; refresh probe inputs when its worktree moved head/branch, else a merged linked PR lingers after a switch.
      existing.candidate = {
        ...existing.candidate,
        cacheKey: candidate.cacheKey,
        branch: candidate.branch,
        currentHeadOid: candidate.currentHeadOid ?? null
      }
    }
  } else {
    diagnosticsCounters.enqueued += 1
    recordPRRefreshQueueDiagnostic('enqueued', reason)
    queue.set(key, {
      key,
      candidate,
      aliases: new Map([[alias.cacheKey, alias]]),
      reason,
      priority,
      dueAt,
      queuedAt: nextQueueOrder(),
      windowId
    })
  }
  // Why: visible/SWR are background maintenance behind the budget queue; only user/action-driven queueing should surface in UI.
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
  removeInvisibleVisibleRefreshes()
  for (const candidate of candidates) {
    enqueuePRRefresh(candidate, 'visible', 40, windowId)
  }
}

export function _getVisiblePRRefreshWindowCountForTests(): number {
  return visibleByWindow.size
}

export function _getPRRefreshErrorBackoffCountForTests(): number {
  return errorBackoff.size
}

export function _getPRRefreshQueueSizeForTests(): number {
  return queue.size
}

export function _getPRRefreshAliasCountForTests(key: string): number {
  return queue.get(key)?.aliases.size ?? 0
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

  // Why: enforce the rate-limit gate so a stale renderer can't bypass it; refuse without spending quota until the later of the two cooldowns.
  const manualExecutionOptions = ghRepoExecOptions(
    githubRepoContext(candidate.repoPath, candidate.connectionId, candidate.localGitOptions)
  )
  const manualRepository = await getOriginGitHubApiRepository(
    candidate.repoPath,
    candidate.connectionId,
    manualExecutionOptions
  )
  const manualBlockedGuard = backgroundRefreshBuckets()
    .map((bucket) => repositoryRateLimitGuard(manualRepository, bucket, manualExecutionOptions))
    .find((guard) => guard.blocked)
  const secondaryGateUntil = manualRetryGates.get(key)
  const gateUntil = Math.max(
    manualBlockedGuard?.blocked ? manualBlockedGuard.resetAt * 1000 : 0,
    secondaryGateUntil !== undefined ? secondaryGateUntil : 0
  )
  if (gateUntil > Date.now()) {
    const retryAt = gateUntil
    // Why: paused maps `pausedUntil` into the renderer's auto-retry, so requeue at reset (finding 12) — don't advertise an unscheduled retry.
    queue.set(key, {
      key,
      candidate,
      aliases: aliasMap,
      reason: 'manual',
      priority: 40,
      dueAt: retryAt,
      queuedAt: nextQueueOrder()
    })
    broadcast({
      aliases,
      reason: 'manual',
      status: 'paused',
      pausedUntil: retryAt,
      skippedReason: 'rate-limit'
    })
    scheduleDrain(Math.max(1_000, retryAt - Date.now()))
    return {
      kind: 'upstream-error',
      errorType: 'rate_limited',
      message: 'GitHub is temporarily limiting requests. Try again after the limit resets.',
      fetchedAt: Date.now(),
      nextAutoRetryAt: retryAt,
      retryDisabledUntil: retryAt
    }
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
    candidate.linkedPRNumber == null ? (candidate.fallbackPRNumber ?? null) : null,
    ...hostedReviewOptionArgs(candidate)
  )
  let plannedRetryAt: number | undefined
  let broadcastOutcome = outcome
  if (outcome.kind === 'upstream-error' && isVisibleKey(key)) {
    plannedRetryAt = nextVisibleErrorRetryAt(key)
    broadcastOutcome = withErrorSchedule(outcome, plannedRetryAt)
  }
  outcomeObserver?.(candidate, outcome)
  noteManualRetryGate(key, broadcastOutcome)
  broadcast(
    { aliases, reason: 'manual', outcome: broadcastOutcome, requestStartedAt },
    requestSequence
  )
  scheduleVisibleFollowUp(key, candidate, outcome, 40, aliases, undefined, {
    plannedRetryAt,
    // Why: GitHub reports UNKNOWN right after `gh pr reopen`; one prompt visible retry replaces the transient label.
    pendingMergeabilityDelayMs: MANUAL_MERGEABILITY_PENDING_REFRESH_MS
  })
  return broadcastOutcome
}
