import type {
  RuntimeCloseIntent,
  RuntimeUserCloseSource
} from '../../../shared/runtime-close-intent'

export type RuntimeCloseClientContext = {
  clientKind?: 'mobile' | 'runtime'
  connectionId?: string
  deviceId?: string
}

export type RuntimeCloseTarget =
  | { kind: 'session-tab'; worktree: string; tabId: string }
  | { kind: 'terminal'; terminal: string }
  // Why: terminal.closeTab destroys every pane in the tab, so it must not be
  // reachable through a creation-ownership rollback token scoped to one pane.
  | { kind: 'terminal-tab'; terminal: string }

export type RuntimeCloseBlockedReason =
  | 'close_intent_required'
  | 'close_intent_mismatch'
  | 'close_intent_duplicate'
  | 'close_source_not_allowed'
  | 'close_rollback_not_owned'
  | 'close_rate_limited'
  | 'close_tracking_capacity_exceeded'

export type RuntimeCloseDecision =
  | {
      allowed: true
      reason: 'legacy-client' | 'explicit-user' | 'owned-rollback'
      recentlyAttached: boolean
    }
  | {
      allowed: false
      reason: RuntimeCloseBlockedReason
      recentlyAttached: boolean
    }

export type RuntimeClosePolicyOptions = {
  now?: () => number
  rollbackTtlMs?: number
  attachmentTtlMs?: number
  rateWindowMs?: number
  maxClosesPerWindow?: number
  maxTrackedEntriesPerActor?: number
}

const USER_CLOSE_SOURCES: ReadonlySet<string> = new Set<RuntimeUserCloseSource>([
  'user-tab-close',
  'user-pane-close',
  'user-bulk-close',
  'cli',
  'automation'
])

const DEFAULT_ROLLBACK_TTL_MS = 30_000
const DEFAULT_ATTACHMENT_TTL_MS = 10_000
const DEFAULT_RATE_WINDOW_MS = 10_000
const DEFAULT_MAX_CLOSES_PER_WINDOW = 128
const REQUEST_ID_TTL_MS = 10 * 60_000
const DEFAULT_MAX_TRACKED_ENTRIES_PER_ACTOR = 4096

type TimedRecordsByActor = Map<string, Map<string, number>>

function deviceActorKey(ctx: RuntimeCloseClientContext): string {
  return ctx.deviceId ?? ctx.connectionId ?? 'runtime:anonymous'
}

function connectionActorKey(ctx: RuntimeCloseClientContext): string {
  return ctx.connectionId ?? ctx.deviceId ?? 'runtime:anonymous'
}

function targetKey(target: RuntimeCloseTarget): string {
  return target.kind === 'session-tab'
    ? `session:${target.worktree.startsWith('id:') ? target.worktree.slice(3) : target.worktree}`
    : `terminal:${target.terminal}`
}

function worktreeMatches(selector: string, worktreeId: string): boolean {
  return selector === worktreeId || selector === `id:${worktreeId}`
}

function targetMatchesIntent(target: RuntimeCloseTarget, intent: RuntimeCloseIntent): boolean {
  if (target.kind === 'session-tab') {
    return worktreeMatches(target.worktree, intent.worktreeId) && intent.hostTabId === target.tabId
  }
  return intent.ptyOrHandle === target.terminal
}

function pruneTimedRecordsByActor(recordsByActor: TimedRecordsByActor, cutoff: number): void {
  for (const [actor, records] of recordsByActor) {
    for (const [key, recordedAt] of records) {
      if (recordedAt < cutoff) {
        records.delete(key)
      }
    }
    if (records.size === 0) {
      recordsByActor.delete(actor)
    }
  }
}

export class RuntimeClosePolicy {
  private readonly now: () => number
  private readonly rollbackTtlMs: number
  private readonly attachmentTtlMs: number
  private readonly rateWindowMs: number
  private readonly maxClosesPerWindow: number
  private readonly maxTrackedEntriesPerActor: number
  private readonly seenRequestIds: TimedRecordsByActor = new Map()
  private readonly createdTerminalHandles: TimedRecordsByActor = new Map()
  private readonly attachedTargets: TimedRecordsByActor = new Map()
  private readonly closeTimesByActor = new Map<string, number[]>()

  constructor(options: RuntimeClosePolicyOptions = {}) {
    this.now = options.now ?? Date.now
    this.rollbackTtlMs = options.rollbackTtlMs ?? DEFAULT_ROLLBACK_TTL_MS
    this.attachmentTtlMs = options.attachmentTtlMs ?? DEFAULT_ATTACHMENT_TTL_MS
    this.rateWindowMs = options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS
    this.maxClosesPerWindow = options.maxClosesPerWindow ?? DEFAULT_MAX_CLOSES_PER_WINDOW
    this.maxTrackedEntriesPerActor =
      options.maxTrackedEntriesPerActor ?? DEFAULT_MAX_TRACKED_ENTRIES_PER_ACTOR
  }

  recordTerminalCreated(ctx: RuntimeCloseClientContext, terminal: string): void {
    if (ctx.clientKind !== 'runtime') {
      return
    }
    const now = this.now()
    this.prune(now)
    this.recordTimedEntry(this.createdTerminalHandles, connectionActorKey(ctx), terminal, now)
  }

  recordAttachedTarget(ctx: RuntimeCloseClientContext, target: RuntimeCloseTarget): void {
    if (ctx.clientKind !== 'runtime') {
      return
    }
    const now = this.now()
    this.prune(now)
    this.recordTimedEntry(this.attachedTargets, connectionActorKey(ctx), targetKey(target), now)
  }

  evaluate(
    ctx: RuntimeCloseClientContext,
    target: RuntimeCloseTarget,
    intent?: RuntimeCloseIntent
  ): RuntimeCloseDecision {
    if (ctx.clientKind !== 'runtime') {
      return { allowed: true, reason: 'legacy-client', recentlyAttached: false }
    }

    const now = this.now()
    this.prune(now)
    const actor = deviceActorKey(ctx)
    const connection = connectionActorKey(ctx)
    const recentlyAttached = this.attachedTargets.get(connection)?.has(targetKey(target)) === true
    if (!intent) {
      return { allowed: false, reason: 'close_intent_required', recentlyAttached }
    }
    if (!targetMatchesIntent(target, intent)) {
      return { allowed: false, reason: 'close_intent_mismatch', recentlyAttached }
    }
    if (this.seenRequestIds.get(actor)?.has(intent.requestId)) {
      return { allowed: false, reason: 'close_intent_duplicate', recentlyAttached }
    }
    if (!this.recordTimedEntry(this.seenRequestIds, actor, intent.requestId, now)) {
      return { allowed: false, reason: 'close_tracking_capacity_exceeded', recentlyAttached }
    }

    // Why: occurredAt is diagnostic only. SSH/WSL/Windows hosts can have clock
    // skew, so replay safety comes from request-id dedupe rather than wall time.
    if (USER_CLOSE_SOURCES.has(intent.source)) {
      if (!intent.userInitiated) {
        return { allowed: false, reason: 'close_intent_mismatch', recentlyAttached }
      }
      if (!this.consumeRateSlot(actor, now)) {
        this.releaseSeenRequestId(actor, intent.requestId)
        return { allowed: false, reason: 'close_rate_limited', recentlyAttached }
      }
      return { allowed: true, reason: 'explicit-user', recentlyAttached }
    }

    if (intent.source === 'client-created-rollback' && !intent.userInitiated) {
      // Why: a creation-ownership token is scoped to the pane it created;
      // closeTab would destroy sibling panes the connection never owned.
      if (target.kind !== 'terminal') {
        return { allowed: false, reason: 'close_rollback_not_owned', recentlyAttached }
      }
      const createdRecords = this.createdTerminalHandles.get(connection)
      const createdAt = createdRecords?.get(target.terminal)
      if (createdAt !== undefined && createdAt >= now - this.rollbackTtlMs) {
        // Why: a rollback is still a destructive close, so it spends the same
        // per-device rate budget as an explicit user close.
        if (!this.consumeRateSlot(actor, now)) {
          this.releaseSeenRequestId(actor, intent.requestId)
          return { allowed: false, reason: 'close_rate_limited', recentlyAttached }
        }
        createdRecords?.delete(target.terminal)
        if (createdRecords?.size === 0) {
          this.createdTerminalHandles.delete(connection)
        }
        return { allowed: true, reason: 'owned-rollback', recentlyAttached }
      }
      return { allowed: false, reason: 'close_rollback_not_owned', recentlyAttached }
    }

    return { allowed: false, reason: 'close_source_not_allowed', recentlyAttached }
  }

  private recordTimedEntry(
    recordsByActor: TimedRecordsByActor,
    actor: string,
    key: string,
    recordedAt: number
  ): boolean {
    // Why: fail closed per actor at capacity; evicting a live global entry lets
    // one paired device erase another device's replay or rollback protection.
    const existing = recordsByActor.get(actor)
    if (existing?.has(key)) {
      existing.set(key, recordedAt)
      return true
    }
    if (existing && existing.size >= this.maxTrackedEntriesPerActor) {
      return false
    }
    const records = existing ?? new Map<string, number>()
    records.set(key, recordedAt)
    recordsByActor.set(actor, records)
    return true
  }

  private releaseSeenRequestId(actor: string, requestId: string): void {
    const records = this.seenRequestIds.get(actor)
    records?.delete(requestId)
    if (records?.size === 0) {
      this.seenRequestIds.delete(actor)
    }
  }

  private consumeRateSlot(actor: string, now: number): boolean {
    const cutoff = now - this.rateWindowMs
    const recent = (this.closeTimesByActor.get(actor) ?? []).filter(
      (recordedAt) => recordedAt >= cutoff
    )
    if (recent.length >= this.maxClosesPerWindow) {
      this.closeTimesByActor.set(actor, recent)
      return false
    }
    recent.push(now)
    this.closeTimesByActor.set(actor, recent)
    return true
  }

  private prune(now: number): void {
    pruneTimedRecordsByActor(this.seenRequestIds, now - REQUEST_ID_TTL_MS)
    pruneTimedRecordsByActor(this.createdTerminalHandles, now - this.rollbackTtlMs)
    pruneTimedRecordsByActor(this.attachedTargets, now - this.attachmentTtlMs)
    const rateCutoff = now - this.rateWindowMs
    for (const [actor, times] of this.closeTimesByActor) {
      const recent = times.filter((recordedAt) => recordedAt >= rateCutoff)
      if (recent.length === 0) {
        this.closeTimesByActor.delete(actor)
      } else {
        this.closeTimesByActor.set(actor, recent)
      }
    }
  }
}
