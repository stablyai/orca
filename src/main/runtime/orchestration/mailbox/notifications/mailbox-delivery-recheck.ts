import {
  isMailboxTerminalTakingInput,
  type OrchestrationMailboxTerminal
} from '../routing/mailbox-owner'
import { TUI_IDLE_QUIESCENCE_MS } from '../../../terminal/wait/terminal-idle-policy'

export type MailboxDeliveryDecision = {
  foreground?: boolean
  reset?: boolean
  settled?: boolean
  uncertainMailboxes?: readonly string[]
}

type RecheckReaders = {
  terminal(ptyId: string): OrchestrationMailboxTerminal | null
  inFlight(ptyId: string): boolean
  recovering?(ptyId: string): boolean
  held(ptyId: string): boolean
  hasMail(terminal: OrchestrationMailboxTerminal): boolean
  settle(ptyId: string): boolean
  readinessDelay(terminal: OrchestrationMailboxTerminal): number | null
  deliver(ptyId: string): void
}

/** One completion-based retry owner for a terminal's entire mailbox batch. */
export class MailboxDeliveryRecheck {
  private readonly decisions = new Set<string>()
  private readonly foregroundPending = new Set<string>()
  private readonly delays = new Map<string, number>()

  constructor(
    private readonly timers: Map<string, ReturnType<typeof setTimeout>>,
    private readonly read: RecheckReaders
  ) {}

  request(ptyId: string, decision: MailboxDeliveryDecision = {}): void {
    if (decision.settled) {
      if (this.read.settle(ptyId)) {
        this.retire(ptyId)
        return
      }
      this.foregroundPending.delete(ptyId)
    }
    if (decision.foreground === true) {
      this.foregroundPending.add(ptyId)
    }
    if (decision.foreground === false || decision.reset) {
      this.delays.delete(ptyId)
    }
    if (decision.foreground === false) {
      this.foregroundPending.delete(ptyId)
    }
    if (this.read.inFlight(ptyId)) {
      return
    }
    if (this.timers.has(ptyId) || this.decisions.has(ptyId)) {
      return
    }
    this.decisions.add(ptyId)
    queueMicrotask(() => {
      this.decisions.delete(ptyId)
      if (this.timers.has(ptyId) || this.read.inFlight(ptyId)) {
        return
      }
      const terminal = this.read.terminal(ptyId)
      const backoffRequired = this.foregroundPending.has(ptyId) || this.read.held(ptyId)
      if (backoffRequired) {
        this.foregroundPending.add(ptyId)
      }
      const readinessDelay =
        terminal && !backoffRequired ? this.read.readinessDelay(terminal) : null
      if (
        !terminal ||
        (!backoffRequired && readinessDelay === null) ||
        !this.read.hasMail(terminal)
      ) {
        this.retire(ptyId)
        return
      }
      const backoff = this.delays.get(ptyId) ?? 5000
      const stagger = [...ptyId].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 1000, 0)
      const delay = backoffRequired ? backoff + stagger : readinessDelay!
      if (backoffRequired) {
        this.delays.set(ptyId, Math.min(backoff * 2, 60000))
      }
      const timer = setTimeout(() => {
        this.timers.delete(ptyId)
        const current = this.read.terminal(ptyId)
        if (!current || !this.read.hasMail(current)) {
          this.retire(ptyId)
          return
        }
        if (this.read.recovering?.(ptyId)) {
          this.foregroundPending.add(ptyId)
        }
        this.read.deliver(ptyId)
      }, delay)
      timer.unref?.()
      this.timers.set(ptyId, timer)
    })
  }

  needsForegroundEvaluation(ptyId: string): boolean {
    return (
      this.foregroundPending.has(ptyId) ||
      this.read.held(ptyId) ||
      this.read.recovering?.(ptyId) === true
    )
  }

  retire(ptyId: string): void {
    this.clearTimer(ptyId)
    this.delays.delete(ptyId)
    this.foregroundPending.delete(ptyId)
  }

  private clearTimer(ptyId: string): void {
    const timer = this.timers.get(ptyId)
    if (timer) {
      clearTimeout(timer)
    }
    this.timers.delete(ptyId)
  }
}

export function mailboxReadinessRecheckDelay(
  terminal: OrchestrationMailboxTerminal,
  evidence: {
    recovering: boolean
    stagedPointerText: string | undefined
    outputAt: () => number | null
    held: () => boolean
  }
): number | null {
  if (
    !isMailboxTerminalTakingInput(terminal) &&
    !evidence.recovering &&
    !(
      terminal.lastAgentStatusObservedLive &&
      terminal.lastAgentStatus === null &&
      evidence.stagedPointerText !== undefined
    )
  ) {
    return null
  }
  const outputAt = evidence.outputAt()
  const remaining = outputAt === null ? 0 : TUI_IDLE_QUIESCENCE_MS - (Date.now() - outputAt)
  return evidence.held() || remaining <= 0 ? 2000 : remaining + 50
}
