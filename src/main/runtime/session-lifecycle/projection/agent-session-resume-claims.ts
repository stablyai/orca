import {
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata
} from '../../../../shared/agent-session-resume'
import type { TuiAgent } from '../../../../shared/tui-agent'

export type ResumedAgentSession = {
  agent: TuiAgent
  providerSession: AgentProviderSessionMetadata
}

/** One conversation's resume into one pane, from the decision until the hook store covers it. */
export type AgentSessionResumeHold = ResumedAgentSession & {
  paneKey: string
  claimedAt: number
}

/**
 * `unsettled`: shares whose create has neither bound a PTY nor released; `ptys`: exit watchers;
 * `ambiguous`: unsettled shares whose spawn may have run, by the request a retry reconciles.
 */
type Hold = AgentSessionResumeHold & {
  unsettled: number
  ptys: Map<string, () => void>
  ambiguous: Map<string, number>
}

/** A resumer's share of a hold, settled only from its own create's evidence. */
export type AgentSessionResumeClaim = {
  /** The exact PTY this resumer's create produced; the hold ends once every such PTY exits. */
  bind: (ptyId: string) => void
  /** Releases when nothing was dispatched or the spawn proved its exit; otherwise stays held. */
  settleFailure: (dispatched: boolean, error?: unknown) => void
}

/**
 * Which pane is resuming a conversation, taken before any awaited decision and held through the
 * spawn. Why: the duplicate-holder guard reads hook rows, which an SSH resume (never seeded) or a
 * spawn still in flight has not written yet, so two resumers could both pass it.
 */
export class AgentSessionResumeClaims {
  private readonly holds = new Set<Hold>()
  private stopWatchingReports: (() => void) | null = null

  constructor(
    private readonly lifecycle: {
      /** The hook store now names the session in the hold's pane. */
      reported: (hold: AgentSessionResumeHold) => boolean
      /** Calls `onExit` once the PTY proves exited; returns the unsubscribe. */
      watchExit: (ptyId: string, onExit: () => void) => () => void
      /** Calls `onChange` whenever the hook store's sessions change; returns the unsubscribe. */
      watchReports?: (onChange: () => void) => () => void
    }
  ) {}

  /**
   * Null while another pane's resume of this conversation is unsettled.
   * `request`: names one create, which every retry of it reconciles rather than spawning anew, so
   * a retry's bound PTY also accounts for an earlier attempt whose reply was lost.
   */
  claim(
    session: ResumedAgentSession,
    paneKey: string,
    request?: string
  ): AgentSessionResumeClaim | null {
    const held = this.find(session)
    if (held) {
      // Why: overlapping opens of one pane resume alongside each other (claimSleepRecordForPane).
      if (held.paneKey !== paneKey) {
        return null
      }
      held.unsettled += 1
      return this.share(held, request)
    }
    const hold: Hold = {
      ...session,
      paneKey,
      claimedAt: Date.now(),
      unsettled: 1,
      ptys: new Map(),
      ambiguous: new Map()
    }
    this.holds.add(hold)
    // Why eager: an agent that exits to its shell takes its hook row with it, so a check at the
    // next claim would find nothing and hold the session for as long as the shell lives.
    this.stopWatchingReports ??=
      this.lifecycle.watchReports?.(() => {
        for (const held of this.holds) {
          if (this.reportCoversHold(held)) {
            this.end(held)
          }
        }
      }) ?? null
    return this.share(hold, request)
  }

  private find(session: ResumedAgentSession): Hold | undefined {
    for (const hold of this.holds) {
      if (
        hold.agent !== session.agent ||
        !agentProviderSessionsEqual(hold.agent, hold.providerSession, session.providerSession)
      ) {
        continue
      }
      // Why here too: a host without report notifications ends holds only at the next claim.
      if (this.reportCoversHold(hold)) {
        this.end(hold)
        continue
      }
      return hold
    }
    return undefined
  }

  private reportCoversHold(hold: Hold): boolean {
    // A pane report cannot account for a second overlapping spawn or a lost reply.
    return hold.unsettled === 0 && hold.ptys.size === 1 && this.lifecycle.reported(hold)
  }

  private end(hold: Hold): void {
    for (const stopWatching of hold.ptys.values()) {
      stopWatching()
    }
    this.holds.delete(hold)
    if (this.holds.size === 0) {
      this.stopWatchingReports?.()
      this.stopWatchingReports = null
    }
  }

  private endIfSettled(hold: Hold): void {
    if (hold.unsettled === 0 && hold.ptys.size === 0) {
      this.end(hold)
    }
  }

  private share(hold: Hold, request: string | undefined): AgentSessionResumeClaim {
    let open = true
    return {
      bind: (ptyId) => {
        if (!open) {
          return
        }
        open = false
        hold.unsettled -= 1 + (request ? (hold.ambiguous.get(request) ?? 0) : 0)
        if (request) {
          hold.ambiguous.delete(request)
        }
        // Why every PTY: overlapping opens of one pane can each spawn, and any may still write.
        if (this.holds.has(hold) && !hold.ptys.has(ptyId)) {
          hold.ptys.set(ptyId, () => {})
          const stopWatching = this.lifecycle.watchExit(ptyId, () => {
            hold.ptys.get(ptyId)?.()
            hold.ptys.delete(ptyId)
            this.endIfSettled(hold)
          })
          if (hold.ptys.has(ptyId)) {
            hold.ptys.set(ptyId, stopWatching)
          }
        }
      },
      settleFailure: (dispatched, error) => {
        // Why: a dispatched spawn with no identified PTY may still run (a lost SSH reply).
        const exitedDuringStart =
          error instanceof Error && error.message === 'agent_session_exited_during_start'
        if (!open) {
          return
        }
        if (dispatched && !exitedDuringStart) {
          // Held until a retry of the same request binds the create it reconciles, or forever.
          if (request) {
            open = false
            hold.ambiguous.set(request, (hold.ambiguous.get(request) ?? 0) + 1)
          }
          return
        }
        open = false
        hold.unsettled -= 1
        this.endIfSettled(hold)
      }
    }
  }
}
