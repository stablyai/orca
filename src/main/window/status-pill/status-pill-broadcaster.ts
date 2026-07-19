import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import type { StatusPillAgentRow, StatusPillSummary } from '../../../shared/status-pill-preload-api'
import { computeStatusPillAgentRows, computeStatusPillSummary } from './status-pill-summary'

/** Coalesce window for status → pill forwarding. Bounds the IPC rate into the
 *  pill renderer so a burst of hook events cannot overwhelm the small overlay
 *  process. Matches the design doc's broadcaster budget. */
const COALESCE_MS = 250

export type StatusPillBroadcastPayload = {
  summary: StatusPillSummary
  rows: StatusPillAgentRow[]
}

export type StatusPillBroadcasterOptions = {
  /** Returns the current full snapshot of agent statuses. Pulled lazily inside
   *  each coalesce window so the broadcaster never holds a stale copy. */
  getSnapshot: () => AgentStatusIpcPayload[]
  /** Called with the freshly computed summary + rows at most once per coalesce
   *  window. */
  send: (payload: StatusPillBroadcastPayload) => void
  /** Now timer; defaults to Date.now. */
  now?: () => number
  /** Scheduler; defaults to setTimeout. Useful in tests. */
  scheduler?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  /** Clear scheduler; defaults to clearTimeout. */
  clearScheduler?: (handle: ReturnType<typeof setTimeout>) => void
}

export class StatusPillBroadcaster {
  private readonly getSnapshot: () => AgentStatusIpcPayload[]
  private readonly send: (payload: StatusPillBroadcastPayload) => void
  private readonly now: () => number
  private readonly scheduler: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>
  private readonly clearScheduler: (handle: ReturnType<typeof setTimeout>) => void
  private pending: ReturnType<typeof setTimeout> | null = null
  private lastSent: StatusPillBroadcastPayload | null = null
  private destroyed = false

  constructor(options: StatusPillBroadcasterOptions) {
    this.getSnapshot = options.getSnapshot
    this.send = options.send
    this.now = options.now ?? Date.now
    this.scheduler = options.scheduler ?? setTimeout
    this.clearScheduler = options.clearScheduler ?? clearTimeout
  }

  /** Called by upstream whenever agent status changes. Triggers a coalesced
   *  recompute + send. Safe to call after destroy(); becomes a no-op. */
  scheduleBroadcast(): void {
    if (this.destroyed) {
      return
    }
    if (this.pending !== null) {
      // Why: one in-flight coalesce timer is enough — the snapshot is pulled
      // when the timer fires, so subsequent hook events during the window are
      // folded into the same send.
      return
    }
    this.pending = this.scheduler(() => {
      this.pending = null
      this.flushNow()
    }, COALESCE_MS)
  }

  /** Force an immediate broadcast, bypassing the coalesce window. Used on
   *  initial mount so the pill shows correct state without a 250 ms blank. */
  flushNow(): void {
    if (this.destroyed) {
      return
    }
    let snapshot: AgentStatusIpcPayload[]
    try {
      snapshot = this.getSnapshot()
    } catch {
      // Why: a snapshot failure (e.g. renderer mid-teardown) should not crash
      // the broadcaster; just skip this flush.
      return
    }
    const now = this.now()
    const payload: StatusPillBroadcastPayload = {
      summary: computeStatusPillSummary(snapshot, now),
      rows: computeStatusPillAgentRows(snapshot, now)
    }
    if (payloadsEqual(this.lastSent, payload)) {
      return
    }
    this.lastSent = payload
    try {
      this.send(payload)
    } catch {
      // Swallow; the renderer may be gone.
    }
  }

  /** Stop all timers and ignore future scheduleBroadcast calls. Idempotent. */
  destroy(): void {
    if (this.destroyed) {
      return
    }
    this.destroyed = true
    if (this.pending !== null) {
      this.clearScheduler(this.pending)
      this.pending = null
    }
    this.lastSent = null
  }
}

function payloadsEqual(
  a: StatusPillBroadcastPayload | null,
  b: StatusPillBroadcastPayload
): boolean {
  if (!a) {
    return false
  }
  if (!summariesEqual(a.summary, b.summary)) {
    return false
  }
  if (a.rows.length !== b.rows.length) {
    return false
  }
  for (let i = 0; i < a.rows.length; i++) {
    if (!rowsEqual(a.rows[i], b.rows[i])) {
      return false
    }
  }
  return true
}

function summariesEqual(a: StatusPillSummary, b: StatusPillSummary): boolean {
  return (
    a.working === b.working &&
    a.blocked === b.blocked &&
    a.waiting === b.waiting &&
    a.recentDone === b.recentDone &&
    a.hasAnyActivity === b.hasAnyActivity &&
    a.activityLabel === b.activityLabel &&
    a.activityPaneKey === b.activityPaneKey &&
    a.activePaneKey === b.activePaneKey &&
    a.activeTabId === b.activeTabId
  )
}

function rowsEqual(a: StatusPillAgentRow, b: StatusPillAgentRow): boolean {
  return (
    a.paneKey === b.paneKey &&
    a.agentType === b.agentType &&
    a.state === b.state &&
    a.prompt === b.prompt &&
    a.toolName === b.toolName &&
    a.terminalName === b.terminalName &&
    a.worktreeLabel === b.worktreeLabel &&
    a.receivedAt === b.receivedAt &&
    a.tabId === b.tabId
  )
}
