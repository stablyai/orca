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

export type RuntimeCloseBlockedReason =
  | 'close_intent_required'
  | 'close_intent_mismatch'
  | 'close_intent_duplicate'
  | 'close_source_not_allowed'
  | 'close_rollback_not_owned'
  | 'close_rate_limited'

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
const MAX_TRACKED_ENTRIES = 4096

function deviceActorKey(ctx: RuntimeCloseClientContext): string {
  return ctx.deviceId ?? ctx.connectionId ?? 'runtime:anonymous'
}

function connectionActorKey(ctx: RuntimeCloseClientContext): string {
  return ctx.connectionId ?? ctx.deviceId ?? 'runtime:anonymous'
}

function targetKey(target: RuntimeCloseTarget): string {
  return target.kind === 'terminal' ? `terminal:${target.terminal}` : `session:${target.worktree}`
}

function worktreeMatches(selector: string, worktreeId: string): boolean {
  return selector === worktreeId || selector === `id:${worktreeId}`
}

function targetMatchesIntent(target: RuntimeCloseTarget, intent: RuntimeCloseIntent): boolean {
  if (target.kind === 'terminal') {
    return intent.ptyOrHandle === target.terminal
  }
  return worktreeMatches(target.worktree, intent.worktreeId) && intent.hostTabId === target.tabId
}

function pruneTimedMap(map: Map<string, number>, cutoff: number): void {
  for (const [key, recordedAt] of map) {
    if (recordedAt >= cutoff) {
      continue
    }
    map.delete(key)
  }
  while (map.size > MAX_TRACKED_ENTRIES) {
    const oldest = map.keys().next().value as string | undefined
    if (!oldest) {
      break
    }
    map.delete(oldest)
  }
}

export class RuntimeClosePolicy {
  private readonly now: () => number
  private readonly rollbackTtlMs: number
  private readonly attachmentTtlMs: number
  private readonly rateWindowMs: number
  private readonly maxClosesPerWindow: number
  private readonly seenRequestIds = new Map<string, number>()
  private readonly createdTerminalHandles = new Map<string, number>()
  private readonly attachedTargets = new Map<string, number>()
  private readonly closeTimesByActor = new Map<string, number[]>()

  constructor(options: RuntimeClosePolicyOptions = {}) {
    this.now = options.now ?? Date.now
    this.rollbackTtlMs = options.rollbackTtlMs ?? DEFAULT_ROLLBACK_TTL_MS
    this.attachmentTtlMs = options.attachmentTtlMs ?? DEFAULT_ATTACHMENT_TTL_MS
    this.rateWindowMs = options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS
    this.maxClosesPerWindow = options.maxClosesPerWindow ?? DEFAULT_MAX_CLOSES_PER_WINDOW
  }

  recordTerminalCreated(ctx: RuntimeCloseClientContext, terminal: string): void {
    if (ctx.clientKind !== 'runtime') {
      return
    }
    const now = this.now()
    this.prune(now)
    this.createdTerminalHandles.set(`${connectionActorKey(ctx)}\0${terminal}`, now)
  }

  recordAttachedTarget(ctx: RuntimeCloseClientContext, target: RuntimeCloseTarget): void {
    if (ctx.clientKind !== 'runtime') {
      return
    }
    const now = this.now()
    this.prune(now)
    this.attachedTargets.set(`${connectionActorKey(ctx)}\0${targetKey(target)}`, now)
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
    const recentlyAttached = this.attachedTargets.has(`${connection}\0${targetKey(target)}`)
    if (!intent) {
      return { allowed: false, reason: 'close_intent_required', recentlyAttached }
    }
    if (!targetMatchesIntent(target, intent)) {
      return { allowed: false, reason: 'close_intent_mismatch', recentlyAttached }
    }
    const requestKey = `${actor}\0${intent.requestId}`
    if (this.seenRequestIds.has(requestKey)) {
      return { allowed: false, reason: 'close_intent_duplicate', recentlyAttached }
    }
    this.seenRequestIds.set(requestKey, now)

    // Why: occurredAt is diagnostic only. SSH/WSL/Windows hosts can have clock
    // skew, so replay safety comes from request-id dedupe rather than wall time.
    if (USER_CLOSE_SOURCES.has(intent.source)) {
      if (!intent.userInitiated) {
        return { allowed: false, reason: 'close_intent_mismatch', recentlyAttached }
      }
      if (!this.consumeRateSlot(actor, now)) {
        return { allowed: false, reason: 'close_rate_limited', recentlyAttached }
      }
      return { allowed: true, reason: 'explicit-user', recentlyAttached }
    }

    if (intent.source === 'client-created-rollback' && !intent.userInitiated) {
      const createdKey = `${connection}\0${target.kind === 'terminal' ? target.terminal : ''}`
      const createdAt = this.createdTerminalHandles.get(createdKey)
      if (createdAt !== undefined && createdAt >= now - this.rollbackTtlMs) {
        this.createdTerminalHandles.delete(createdKey)
        return { allowed: true, reason: 'owned-rollback', recentlyAttached }
      }
      return { allowed: false, reason: 'close_rollback_not_owned', recentlyAttached }
    }

    return { allowed: false, reason: 'close_source_not_allowed', recentlyAttached }
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
    pruneTimedMap(this.seenRequestIds, now - REQUEST_ID_TTL_MS)
    pruneTimedMap(this.createdTerminalHandles, now - this.rollbackTtlMs)
    pruneTimedMap(this.attachedTargets, now - this.attachmentTtlMs)
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
