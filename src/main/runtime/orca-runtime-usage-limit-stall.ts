import { OrcaRuntimeWithResolveExitWaiters } from './orca-runtime-resolve-exit-waiters'
import { notifyRuntimeListeners } from './runtime-async-boundaries'
import { buildTerminalWaitText, type TerminalTailWaitState } from './terminal-wait-tail-state'
import { detectUsageLimitStall, extractUsageLimitResetAt } from './usage-limit-stall-detection'
import { readUsageLimitMenu } from '../../shared/usage-limit-menu-selection'
import { parsePaneKey } from '../../shared/stable-pane-id'
import type { UsageLimitProvider } from '../../shared/agent-auto-resume-types'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type {
  UsageLimitStallEvent,
  UsageLimitStallSnapshot
} from './runtime-usage-limit-stall-contracts'

export class OrcaRuntimeWithUsageLimitStall extends OrcaRuntimeWithResolveExitWaiters {
  /** Subscribe to usage-limit stall lifecycle events (detected / cleared /
   *  exited). One subscriber — the composition root's AgentAutoResumeService. */
  subscribeUsageLimitStall(listener: (event: UsageLimitStallEvent) => void): () => void {
    this.usageLimitStallListeners.add(listener)
    return () => {
      this.usageLimitStallListeners.delete(listener)
    }
  }

  protected emitUsageLimitStall(event: UsageLimitStallEvent): void {
    notifyRuntimeListeners(
      this.usageLimitStallListeners,
      (listener) => listener(event),
      'usage-limit-stall'
    )
  }

  private ptyUsageLimitProvider(pty: RuntimePtyWorktreeRecord): UsageLimitProvider | null {
    const agent = pty.foregroundAgent ?? pty.launchAgent
    if (agent === 'claude' || agent === 'claude-agent-teams' || agent === 'openclaude') {
      return 'claude'
    }
    return agent === 'codex' ? 'codex' : null
  }

  protected recordPtyUsageLimitStall(
    pty: RuntimePtyWorktreeRecord,
    ptyId: string,
    waitState: TerminalTailWaitState,
    at: number
  ): void {
    const signal = waitState.usageLimitSignal
    if (!signal) {
      return
    }
    // Why: parse the reset from the live tail lines the same scan matched, never
    // from history on disk. The menu carries no time, so this is null for menus.
    const resetsAt =
      signal.reason === 'usage-limit-banner'
        ? extractUsageLimitResetAt(waitState.waitText.split('\n'))
        : null
    pty.usageLimitStall = { reason: signal.reason, resetsAt, detectedAt: at }
    this.emitUsageLimitStall({
      kind: 'detected',
      ptyId,
      // Issue rather than read: a stall reported without a handle is one the
      // service can only give up on ('no-handle'), and panes that never had a
      // handle pre-allocated are exactly the ones nobody is watching.
      handle: this.issuePtyHandle(pty),
      worktreeId: pty.worktreeId ?? null,
      paneKey: pty.paneKey,
      provider: this.ptyUsageLimitProvider(pty),
      reason: signal.reason,
      resetsAt,
      detectedAt: at
    })
  }

  protected clearPtyUsageLimitStall(pty: RuntimePtyWorktreeRecord, ptyId: string): void {
    if (!pty.usageLimitStall) {
      return
    }
    pty.usageLimitStall = null
    this.emitUsageLimitStall({ kind: 'cleared', ptyId })
  }

  /** Re-announce recorded stalls for one terminal tab's PTYs. The runtime
   *  records every stall, but the watcher drops events for unarmed terminals —
   *  so ticking "Rate limit watcher" while an agent is already parked at the
   *  chooser would otherwise arm a watcher that never hears about the stall it
   *  was armed for. A stale record is harmless: the listener re-verifies
   *  against the live tail before acting. */
  reemitUsageLimitStallsForTab(tabId: string): void {
    for (const [ptyId, pty] of this.ptysById) {
      const stall = pty.usageLimitStall
      if (!stall) {
        continue
      }
      const paneTabId = pty.tabId ?? parsePaneKey(pty.paneKey ?? '')?.tabId
      if (paneTabId !== tabId) {
        continue
      }
      this.emitUsageLimitStall({
        kind: 'detected',
        ptyId,
        handle: this.issuePtyHandle(pty),
        worktreeId: pty.worktreeId ?? null,
        paneKey: pty.paneKey,
        provider: this.ptyUsageLimitProvider(pty),
        reason: stall.reason,
        resetsAt: stall.resetsAt,
        detectedAt: stall.detectedAt
      })
    }
  }

  /** Re-scan the live tail for the service's pre-send verification. Returns null
   *  when the PTY is gone or was never recorded as limited. */
  getUsageLimitStallSnapshot(ptyId: string): UsageLimitStallSnapshot | null {
    const pty = this.ptysById.get(ptyId)
    if (!pty || !pty.usageLimitStall) {
      return null
    }
    const waitText = buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
    const liveSignal = detectUsageLimitStall(waitText.toLowerCase())
    const reason = pty.usageLimitStall.reason
    // A dismissed chooser leaves its text in the retained tail forever, so text
    // presence alone reads as "still parked" for the rest of the PTY's life —
    // which parked every scheduled message on the pane behind a permanent defer.
    // The screen is the truth, but only where it is legible: `live` lets the
    // watcher act, `dismissed` lets a message through, and the unreadable middle
    // says no to both rather than yes to whichever caller asked.
    const menu = liveSignal?.reason === 'usage-limit-menu' ? readUsageLimitMenu(waitText) : null
    return {
      ptyId,
      // Read-only: minting here would register a synthetic handle from a 30s
      // verification tick and block the pane's real one from being adopted later.
      handle: this.handleByPtyId.get(ptyId) ?? this.findHandleForPtyRecord(ptyId) ?? null,
      worktreeId: pty.worktreeId ?? null,
      paneKey: pty.paneKey,
      provider: this.ptyUsageLimitProvider(pty),
      reason,
      resetsAt: pty.usageLimitStall.resetsAt,
      detectedAt: pty.usageLimitStall.detectedAt,
      actionable:
        reason !== 'usage-limit-cli-waiting' &&
        liveSignal?.reason === reason &&
        (reason !== 'usage-limit-menu' || menu?.state === 'live'),
      // The chooser is still the last thing on screen, we just cannot read this
      // frame: the caller may re-read, but may not act.
      indeterminate: liveSignal?.reason === reason && menu?.state === 'unreadable',
      blocksDelivery: liveSignal !== null && menu?.state !== 'dismissed',
      agentWorking: pty.lastAgentStatus === 'working',
      waitText
    }
  }
}
