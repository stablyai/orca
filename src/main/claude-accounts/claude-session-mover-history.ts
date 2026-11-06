import type {
  ClaudeManagedAccountSummary,
  ClaudeSessionMoveSummary
} from '../../shared/managed-account-types'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { noteClaudeSessionMoveStat } from './claude-session-move-stats'

type ClaudeAccountSessionMoved = {
  ptyId: string
  fromAccountId: string
  toAccountId: string
  previousPtyId?: string
}

let sessionMovedListener: ((payload: ClaudeAccountSessionMoved) => void) | null = null

/** Test seam. The plugin event lands in a later change and calls this same shape. */
export function setClaudeAccountSessionMovedListener(
  listener: ((payload: ClaudeAccountSessionMoved) => void) | null
): void {
  sessionMovedListener = listener
}

function publishClaudeAccountSessionMoved(payload: ClaudeAccountSessionMoved): void {
  sessionMovedListener?.(payload)
}
import {
  claudeSessionMoveNoticeDetail,
  worstClaudeWindow,
  type ClaudeTargetClaim
} from './claude-session-mover-policy'
import type { ClaudeMoverSessionView } from './claude-session-mover-sessions'
import type {
  ClaudeSessionMoverDeps,
  ClaudeSessionMoveNotice,
  ClaudeSessionMoveReason
} from './claude-session-mover-types'

export function createClaudeMoverHistory(deps: ClaudeSessionMoverDeps) {
  const lastMoveAt = new Map<string, number>()
  const lastFailureAt = new Map<string, number>()
  const lastAskAt = new Map<string, number>()
  const backgroundWaitAt = new Map<string, number>()
  const lastDecision = new Map<string, ClaudeSessionMoveSummary>()
  const targetClaims = new Map<string, ClaudeTargetClaim>()
  const inflight = new Set<string>()
  const inflightPanes = new Set<string>()
  const log = deps.log ?? ((line, record) => console.info(`[claude-session-mover] ${line}`, record))

  const remember = (
    view: ClaudeMoverSessionView,
    from: ClaudeManagedAccountSummary,
    to: ClaudeManagedAccountSummary | null,
    reason: ClaudeSessionMoveReason,
    usage: ProviderRateLimits | null,
    now: number,
    detail?: string
  ): void => {
    const window = worstClaudeWindow(usage, now)
    const record: ClaudeSessionMoveSummary = {
      ptyId: view.record.ptyId,
      paneKey: view.paneKey,
      fromAccountId: from.id,
      toAccountId: to?.id ?? null,
      window: window?.name ?? null,
      percent: window?.percent ?? null,
      line: window?.line ?? null,
      reason,
      at: now,
      strategy: view.record.proxySlot ? 'proxy' : 'resume'
    }
    // Why once per reason: the service publishes every 15 s; a repeated "stay" is not news.
    if (lastDecision.get(view.record.ptyId)?.reason !== reason) {
      log(
        `${reason}${detail ? ` (${detail})` : ''} pty=${record.ptyId} from=${from.email} to=${to?.email ?? '-'}`,
        record
      )
    }
    lastDecision.set(view.record.ptyId, record)
  }

  const settle =
    (
      view: ClaudeMoverSessionView,
      from: ClaudeManagedAccountSummary,
      to: ClaudeManagedAccountSummary,
      usage: ProviderRateLimits | null,
      balance: boolean
    ) =>
    (kind: ClaudeSessionMoveNotice['kind'], detail: string): void => {
      const now = Date.now()
      if (kind === 'moved') {
        lastMoveAt.set(view.record.ptyId, now)
        lastMoveAt.set(detail, now)
        lastDecision.delete(view.record.ptyId)
        // Raw pty id, before the notice suffix, so plugins do not parse display text.
        publishClaudeAccountSessionMoved({
          ptyId: detail,
          fromAccountId: from.id,
          toAccountId: to.id,
          ...(detail !== view.record.ptyId ? { previousPtyId: view.record.ptyId } : {})
        })
      } else {
        lastFailureAt.set(view.record.ptyId, now)
      }
      remember(
        kind === 'moved' ? { ...view, record: { ...view.record, ptyId: detail } } : view,
        from,
        kind === 'moved' ? to : null,
        kind === 'moved' && balance ? 'rebalance' : kind,
        usage,
        now,
        detail
      )
      if (kind === 'moved' || kind === 'failed') {
        noteClaudeSessionMoveStat({
          strategy: view.record.proxySlot ? 'proxy' : 'resume',
          rebalance: kind === 'moved' && balance,
          failed: kind === 'failed'
        })
      }
      deps.onNotice({
        kind,
        ptyId: view.record.ptyId,
        paneKey: view.paneKey,
        from,
        to: kind === 'moved' ? to : null,
        detail: claudeSessionMoveNoticeDetail(detail, kind === 'moved' && view.paneBackgroundWork),
        ...(kind === 'moved' && detail === view.record.ptyId ? { restartless: true as const } : {}),
        ...(kind === 'moved' && balance ? { balance: true as const } : {})
      })
    }

  return {
    lastMoveAt,
    lastFailureAt,
    lastAskAt,
    backgroundWaitAt,
    lastDecision,
    targetClaims,
    inflight,
    inflightPanes,
    remember,
    settle
  }
}
export type ClaudeMoverHistory = ReturnType<typeof createClaudeMoverHistory>
