import type { ClaudeSessionMoverSetting } from '../../shared/claude-account-switch-settings'
import type { AgentStatusState } from '../../shared/agent-status/contracts/agent-status-types'
import type {
  InactiveAccountUsage,
  ProviderRateLimits,
  RateLimitWindow
} from '../../shared/rate-limit-types'
import { DEFAULT_POLL_MS } from '../rate-limits/service/service-types'
import {
  claudeAutoSwitchHeadroom,
  claudeAutoSwitchWindows,
  isClaudeAtLimit,
  pickClaudeAutoSwitchTarget,
  type ClaudeAutoSwitchWindowName
} from './claude-account-auto-switch-policy'

/** Per session: a moved session is not moved again for this long (unless its account hits the limit). */
export const CLAUDE_SESSION_MOVE_COOLDOWN_MS = 5 * 60_000
/** Per target: a claimed account is not offered to another session for this long. */
export const CLAUDE_SESSION_MOVE_TARGET_COOLDOWN_MS = 60_000
/** Per session: after a failed or skipped move, no retry for this long. */
export const CLAUDE_SESSION_MOVE_FAILURE_HOLD_MS = 60_000
/** How long a settled main agent may keep a live shell or monitor. The hard limit does not wait. */
export const CLAUDE_SESSION_MOVE_BACKGROUND_WAIT_MS = 10 * 60_000
/** One turn's worth of a 5-hour window, debited from a target's reading after each move that claimed it. */
export const CLAUDE_SESSION_MOVE_CLAIM_DEBIT_PERCENT = 5
/** A proxy session this far behind the best account moves before the 95/90 lines. */
export const CLAUDE_POOL_REBALANCE_GAP_PTS = 25
/** The best account must still have this much room, or a rebalance is not worth the cache miss. */
export const CLAUDE_POOL_REBALANCE_MIN_TARGET_HEADROOM = 30
/** At most one rebalance per pane in this window. A hard-line move keeps the shorter cooldown. */
export const CLAUDE_POOL_REBALANCE_COOLDOWN_MS = 15 * 60_000
/** A turn that just ended still has a warm prompt cache. A flip would miss it. */
export const CLAUDE_POOL_REBALANCE_QUIET_MS = 2 * 60_000

export type ClaudeTargetClaim = { at: number; debit: number }
export type ClaudeSessionMoveWindow = {
  name: ClaudeAutoSwitchWindowName
  percent: number
  line: number
}

export type ClaudeSessionMoveDecision =
  | {
      kind: 'stay'
      reason:
        | 'off'
        | 'no-usage'
        | 'under-line'
        | 'cooldown'
        | 'failed-recently'
        | 'no-target'
        | 'prompt-cache'
    }
  | { kind: 'read-usage' }
  | { kind: 'wait'; reason: 'mid-turn' | 'no-status' | 'background-work' }
  | { kind: 'move'; to: string; window: ClaudeSessionMoveWindow; reason?: 'rebalance' }

/** Ask and move notices name this wait while the shell or monitor is still alive. */
export function claudeSessionMoveNoticeDetail(detail: string, backgroundWork: boolean): string {
  return backgroundWork ? `${detail} (wait:background-work)` : detail
}

export type ClaudeSessionMoveInputs = {
  now: number
  setting: ClaudeSessionMoverSetting
  pinned: boolean
  paneState: AgentStatusState | null
  /** A shell, cron, or monitor is still alive after the main agent. */
  paneBackgroundWork?: boolean
  /**
   * When the current background-work wait started. 0 or omitted means it has not been
   * stamped yet, which still waits; the caller records that instant.
   */
  backgroundWaitStartedAt?: number
  /** The session's own account's reading. */
  usage: ProviderRateLimits | null
  /** Readings of the other signed-in accounts of the same runtime. */
  candidates: InactiveAccountUsage[]
  /** How many such accounts exist, read or not. */
  candidateCount: number
  lastUsageReadAt: number
  lastMoveAt: number
  lastFailureAt: number
  targetClaims: ReadonlyMap<string, ClaudeTargetClaim>
  /** A proxy flip takes effect on the next request, so it does not wait for the turn to end. */
  allowMidTurn?: boolean
  /**
   * Pool spread. `enabled` is the pool setting. `spreadLine` is a proxy session: a restart is
   * not required, so the session may move before the 95/90 lines. Resume sessions leave it false.
   */
  pool?: { enabled: boolean; spreadLine: boolean }
  /** When this pane's last turn ended. Absent until the hook publishes one. */
  turnEndedAt?: number
}

/** A reading newer than one poll. Shared with the account pool, which skips anything older. */
export function isClaudeUsageFresh(usage: { updatedAt: number } | null, now: number): boolean {
  return usage !== null && now - usage.updatedAt <= DEFAULT_POLL_MS
}

function isFresh(usage: { updatedAt: number } | null, now: number): boolean {
  return isClaudeUsageFresh(usage, now)
}

/** The window nearest (or furthest over) its line; null when usage could not be read. */
export function worstClaudeWindow(
  limits: ProviderRateLimits | null,
  now: number
): ClaudeSessionMoveWindow | null {
  const windows = claudeAutoSwitchWindows(limits, now)
  if (!windows) {
    return null
  }
  const worst = windows.reduce((a, b) => (b.line - b.used < a.line - a.used ? b : a))
  return { name: worst.name, percent: worst.used, line: worst.line }
}

/** A claimed target reads as if the claiming session had already spent a turn on it. */
export function debitClaimedUsage(
  usage: InactiveAccountUsage,
  claim: ClaudeTargetClaim | undefined,
  now: number
): InactiveAccountUsage {
  if (!claim || now - claim.at >= CLAUDE_SESSION_MOVE_COOLDOWN_MS || !usage.rateLimits) {
    return usage
  }
  const debit = (window: RateLimitWindow | null | undefined): RateLimitWindow | null =>
    window ? { ...window, usedPercent: Math.min(100, window.usedPercent + claim.debit) } : null
  const { rateLimits } = usage
  return {
    ...usage,
    rateLimits: {
      ...rateLimits,
      session: debit(rateLimits.session),
      weekly: debit(rateLimits.weekly),
      ...(rateLimits.fableWeekly !== undefined
        ? { fableWeekly: debit(rateLimits.fableWeekly) }
        : {})
    }
  }
}

type CandidateReadiness =
  | { kind: 'read-usage' }
  | { kind: 'stay'; reason: 'no-usage' }
  | { kind: 'ready'; fresh: InactiveAccountUsage[] }

/** Open, fresh, debited candidates. A recent claim is not offered; an older one still costs its debit. */
function candidateReadiness(inputs: ClaudeSessionMoveInputs): CandidateReadiness {
  const { now } = inputs
  const open = inputs.candidates.filter((candidate) => {
    const claim = inputs.targetClaims.get(candidate.accountId)
    return !claim || now - claim.at >= CLAUDE_SESSION_MOVE_TARGET_COOLDOWN_MS
  })
  const fresh = open
    .filter((candidate) => isFresh(candidate, now))
    .map((candidate) =>
      debitClaimedUsage(candidate, inputs.targetClaims.get(candidate.accountId), now)
    )
  // Why: an account inside its Retry-After cannot be read, so ranking does not wait for it.
  const unreadable = open.filter(
    (candidate) =>
      !isFresh(candidate, now) && (candidate.rateLimits?.usageMetadata?.retryAtMs ?? 0) > now
  )
  const claimedOut = inputs.candidates.length - open.length
  if (fresh.length + unreadable.length + claimedOut < inputs.candidateCount) {
    if (inputs.candidates.some((candidate) => candidate.isFetching)) {
      return { kind: 'stay', reason: 'no-usage' }
    }
    if (now - inputs.lastUsageReadAt >= DEFAULT_POLL_MS) {
      return { kind: 'read-usage' }
    }
  }
  return { kind: 'ready', fresh }
}

function bestRebalanceCandidate(
  fresh: InactiveAccountUsage[],
  now: number
): { accountId: string; headroom: number } | null {
  const ranked = fresh.flatMap((candidate) => {
    const headroom = claudeAutoSwitchHeadroom(candidate.rateLimits, now)
    return headroom !== null && !isClaudeAtLimit(candidate.rateLimits, now)
      ? [{ accountId: candidate.accountId, headroom }]
      : []
  })
  ranked.sort((a, b) => b.headroom - a.headroom || a.accountId.localeCompare(b.accountId))
  return ranked[0] ?? null
}

/**
 * Move a proxy session before the 95/90 lines when another account is clearly freer.
 * Null means the hard line still decides (including "stay under the line").
 */
function decidePoolRebalance(
  inputs: ClaudeSessionMoveInputs,
  headroom: number | null
): ClaudeSessionMoveDecision | null {
  if (!inputs.pool?.enabled || !inputs.pool.spreadLine || inputs.pinned || headroom === null) {
    return null
  }
  // A live turn is a burst. The hard line still moves a proxy session; a rebalance waits.
  if (inputs.paneState !== 'done') {
    return null
  }
  const { now } = inputs
  const ready = candidateReadiness(inputs)
  if (ready.kind !== 'ready') {
    if (
      inputs.turnEndedAt !== undefined &&
      now - inputs.turnEndedAt < CLAUDE_POOL_REBALANCE_QUIET_MS
    ) {
      return { kind: 'stay', reason: 'prompt-cache' }
    }
    if (now - inputs.lastMoveAt < CLAUDE_POOL_REBALANCE_COOLDOWN_MS) {
      return { kind: 'stay', reason: 'cooldown' }
    }
    if (now - inputs.lastFailureAt < CLAUDE_SESSION_MOVE_FAILURE_HOLD_MS) {
      return { kind: 'stay', reason: 'failed-recently' }
    }
    return ready
  }
  const best = bestRebalanceCandidate(ready.fresh, now)
  if (
    !best ||
    best.headroom < CLAUDE_POOL_REBALANCE_MIN_TARGET_HEADROOM ||
    headroom >= best.headroom - CLAUDE_POOL_REBALANCE_GAP_PTS
  ) {
    return null
  }
  // Why after the gap test: a pane that just landed on the freer account is under the line, not cooling down.
  if (
    inputs.turnEndedAt !== undefined &&
    now - inputs.turnEndedAt < CLAUDE_POOL_REBALANCE_QUIET_MS
  ) {
    return { kind: 'stay', reason: 'prompt-cache' }
  }
  if (now - inputs.lastFailureAt < CLAUDE_SESSION_MOVE_FAILURE_HOLD_MS) {
    return { kind: 'stay', reason: 'failed-recently' }
  }
  if (now - inputs.lastMoveAt < CLAUDE_POOL_REBALANCE_COOLDOWN_MS) {
    return { kind: 'stay', reason: 'cooldown' }
  }
  const window = worstClaudeWindow(inputs.usage, now)
  return window
    ? { kind: 'move', to: best.accountId, window, reason: 'rebalance' }
    : { kind: 'stay', reason: 'no-usage' }
}

export function decideClaudeSessionMove(
  inputs: ClaudeSessionMoveInputs
): ClaudeSessionMoveDecision {
  const { now, usage } = inputs
  if (inputs.setting === 'off') {
    return { kind: 'stay', reason: 'off' }
  }
  // Why a stale reading never moves: the window may have reset since; ask once per poll interval.
  if (!usage || usage.status !== 'ok' || !isFresh(usage, now)) {
    return now - inputs.lastUsageReadAt >= DEFAULT_POLL_MS
      ? { kind: 'read-usage' }
      : { kind: 'stay', reason: 'no-usage' }
  }
  const atLimit = isClaudeAtLimit(usage, now)
  const headroom = claudeAutoSwitchHeadroom(usage, now)
  const over = inputs.pinned ? atLimit : headroom !== null && headroom <= 0
  if (!over) {
    return decidePoolRebalance(inputs, headroom) ?? { kind: 'stay', reason: 'under-line' }
  }
  if (now - inputs.lastFailureAt < CLAUDE_SESSION_MOVE_FAILURE_HOLD_MS) {
    return { kind: 'stay', reason: 'failed-recently' }
  }
  if (!atLimit && now - inputs.lastMoveAt < CLAUDE_SESSION_MOVE_COOLDOWN_MS) {
    return { kind: 'stay', reason: 'cooldown' }
  }
  // Why never mid-turn: a restart during a tool call or a permission prompt loses the turn.
  // A proxy move does not restart, so it skips these waits and still keeps the claim, cooldown, and debit.
  if (!inputs.allowMidTurn) {
    // paneState is the main agent's own state when the hook published one.
    if (inputs.paneState === null) {
      return { kind: 'wait', reason: 'no-status' }
    }
    if (inputs.paneState !== 'done') {
      return { kind: 'wait', reason: 'mid-turn' }
    }
    // A shell or monitor can outlive the main agent. Hold briefly, and never past the hard limit.
    if (inputs.paneBackgroundWork && !atLimit) {
      const startedAt = inputs.backgroundWaitStartedAt ?? 0
      if (startedAt === 0 || now - startedAt < CLAUDE_SESSION_MOVE_BACKGROUND_WAIT_MS) {
        return { kind: 'wait', reason: 'background-work' }
      }
    }
  }
  const ready = candidateReadiness(inputs)
  if (ready.kind !== 'ready') {
    return ready
  }
  const to = pickClaudeAutoSwitchTarget(usage, ready.fresh, {
    now,
    lastSwitchAt: inputs.lastMoveAt
  })
  if (!to) {
    return { kind: 'stay', reason: 'no-target' }
  }
  const window = worstClaudeWindow(usage, now)
  return window ? { kind: 'move', to, window } : { kind: 'stay', reason: 'no-usage' }
}
