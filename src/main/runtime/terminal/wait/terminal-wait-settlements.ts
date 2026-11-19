import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { OrcaRuntimeWithMailDeliveryRefusal } from './mail-delivery-refusal-runtime'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import {
  buildPtyTerminalWaitBlockedResult,
  buildPtyTerminalWaitExitError,
  buildPtyTerminalWaitResult
} from './terminal-wait-results'
import type { AgentStatus } from '../../../../shared/agent-status/title/agent-title-core'
import { detectExplicitIdleStatusFromTitle } from './terminal-wait-detection'
import { buildTerminalWaitText } from './terminal-wait-tail-state'
import { evaluateTuiIdle, type TuiIdleVerdict } from './tui-idle-evidence'
import { settlesForMidTurnInput } from './terminal-delivery-refusal'
import { ptyTuiIdleEvidence } from './tui-idle-evidence-source'
import {
  MailboxDeliveryRecheck,
  mailboxReadinessRecheckDelay,
  type MailboxDeliveryDecision
} from '../../orchestration/mailbox/notifications/mailbox-delivery-recheck'
import type { MailboxForeground } from './launched-agent-foreground'
import {
  isMailboxTerminalTakingInput,
  type OrchestrationMailboxTerminal
} from '../../orchestration/mailbox/routing/mailbox-owner'
import { tuiAgentDisplayName } from '../../../../shared/agent-launch/catalog/tui-agent-display-names'
import type { MailboxDeliveryHold } from '../../orchestration/mailbox/delivery-hold/mailbox-delivery-hold'
import { terminalMailHoldVerdict } from './terminal-mail-hold-verdict'
import { receiptMailboxOwnershipHold } from '../../orchestration/mailbox/delivery-hold/receipt-mailbox-ownership'

export abstract class OrcaRuntimeWithResolveExitWaiters extends OrcaRuntimeWithMailDeliveryRefusal {
  protected resolvePtyExitWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void {
    for (const waiter of this.terminalWaiters.forPty(ptyId)) {
      // Agent Sleep stopped the process, not the agent: its exit wait follows the woken process.
      if (waiter.condition === 'exit' && this.carrySleptAgentExitWait(waiter)) {
        continue
      }
      if (waiter.condition === 'exit') {
        this.terminalWaiters.resolve(waiter, buildPtyTerminalWaitResult(waiter.handle, 'exit', pty))
      } else {
        // Why: after exit, conditions like tui-idle can never be satisfied — reject now instead of spinning the poll until timeout on a dead process.
        this.terminalWaiters.remove(waiter)
        waiter.reject(buildPtyTerminalWaitExitError(pty))
      }
    }
  }

  protected resolvePtyTuiIdleWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void {
    const waiters = this.terminalWaiters
      .forPty(ptyId)
      .filter((waiter) => waiter.condition === 'tui-idle')
    if (waiters.length === 0) {
      return
    }
    // Re-rank titles: weak readiness cannot see tail-truncated dialogs and must wait for a rendered-screen poll.
    const verdict = this.evaluateTuiIdleForPty(pty)
    for (const waiter of waiters) {
      if (verdict.kind === 'blocked') {
        this.terminalWaiters.resolve(
          waiter,
          buildPtyTerminalWaitBlockedResult(waiter.handle, 'tui-idle', pty, verdict.reason)
        )
      } else if (
        verdict.kind === 'ready-strong' ||
        (waiter.acceptsMidTurnInput &&
          settlesForMidTurnInput(verdict, ptyId, this.tuiIdleEvidenceSource))
      ) {
        this.terminalWaiters.resolve(
          waiter,
          buildPtyTerminalWaitResult(waiter.handle, 'tui-idle', pty)
        )
      }
    }
  }

  private readonly deliveryRechecks = new MailboxDeliveryRecheck(
    this.deliveryRecheckTimersByPtyId,
    {
      terminal: (ptyId) => this.getOrchestrationMailboxTerminal(ptyId),
      inFlight: (ptyId) => this.orchestrationMailboxPointerDelivery.isDeliveryInFlight(ptyId),
      recovering: (ptyId) => this.orchestrationMailboxPointerDelivery.requiresCurrentScreen(ptyId),
      held: (ptyId) => this.orchestrationMailboxPointerDelivery.isForegroundHeld(ptyId),
      hasMail: (terminal) => this.orchestrationMailboxNotifications.hasDeliverableMail(terminal),
      settle: (ptyId) =>
        this.orchestrationMailboxNotifications.settleDelivery(
          this.getOrchestrationMailboxTerminal(ptyId)
        ),
      readinessDelay: (terminal) =>
        mailboxReadinessRecheckDelay(terminal, {
          recovering: this.orchestrationMailboxPointerDelivery.requiresCurrentScreen(
            terminal.ptyId
          ),
          stagedPointerText: this.orchestrationMailboxPointerDelivery.stagedPointerText(
            terminal.ptyId
          ),
          outputAt: () => this.readOutputClockAt(terminal.ptyId),
          held: () => this.ptyDeliveryHold(terminal.ptyId) !== null
        }),
      deliver: (ptyId) => this.deliverPendingMessagesForPty(ptyId)
    }
  )

  protected deliverPendingMessagesForPty(ptyId: string): void {
    const terminal = this.getOrchestrationMailboxTerminal(ptyId)
    if (
      terminal &&
      !this.orchestrationMailboxPointerDelivery.resumeDeferredEnter(terminal) &&
      ((isMailboxTerminalTakingInput(terminal) && this.isAgentSettledForDelivery(ptyId)) ||
        this.deliveryRechecks.needsForegroundEvaluation(ptyId) ||
        this.isMailboxForegroundCandidate(terminal))
    ) {
      this.orchestrationMailboxNotifications.deliverForTerminal(terminal)
    }
    this.armDeliveryRecheck(ptyId)
  }

  protected clearDeliveryRecheck(ptyId: string): void {
    this.deliveryRechecks.retire(ptyId)
  }

  protected needsMailboxForegroundEvaluation(ptyId: string): boolean {
    return this.deliveryRechecks.needsForegroundEvaluation(ptyId)
  }

  protected armDeliveryRecheck(ptyId: string, decision?: MailboxDeliveryDecision): void {
    if (decision?.uncertainMailboxes) {
      this.publishUncertainTerminalMail(ptyId, decision.uncertainMailboxes)
    }
    this.deliveryRechecks.request(ptyId, decision)
  }

  protected isMailboxForegroundCandidate(terminal: OrchestrationMailboxTerminal): boolean {
    return terminal.lastAgentStatus === null && terminal.lastAgentStatusObservedLive
  }

  protected mailboxTerminalAdmission(
    terminal: OrchestrationMailboxTerminal,
    foreground?: MailboxForeground,
    stagedText?: string,
    candidate?: TuiAgent
  ): OrchestrationMailboxTerminal {
    return foreground === 'agent' &&
      terminal.lastAgentStatusObservedLive &&
      (terminal.lastAgentStatus === null ||
        this.orchestrationMailboxPointerDelivery.requiresCurrentScreen(terminal.ptyId)) &&
      this.deliveryRefusal(terminal.ptyId, foreground, stagedText, candidate) === null
      ? { ...terminal, lastAgentStatus: 'idle' }
      : terminal
  }

  /** Pointer plus Enter takes the waits' readiness ranking, plus a working verdict: agents queue or
   *  steer text sent mid-turn, so only dialogs, drafts and unsettled terminals hold mail. Callers
   *  separately require live status evidence. */
  protected isAgentSettledForDelivery(
    ptyId: string,
    foreground?: MailboxForeground,
    stagedText?: string,
    candidate?: TuiAgent
  ): boolean {
    return this.deliveryRefusal(ptyId, foreground, stagedText, candidate) === null
  }

  /** Why delivery would not type a note for this mailbox now, for a send receipt: the gates' own reads,
   *  through the terminal delivery resolves (a Run's current coordinator, a Dispatch's assignee),
   *  once that terminal is shown to read the mailbox. */
  async readTerminalMailHold(
    mailbox: string,
    followup = false
  ): Promise<MailboxDeliveryHold | null> {
    const terminal = this.orchestrationMailboxDeliveryTarget.resolveTerminal(mailbox)
    if (!terminal) {
      return null
    }
    const db = this._orchestrationDb
    const notRead = db ? receiptMailboxOwnershipHold(db, terminal, mailbox) : null
    if (notRead) {
      return notRead
    }
    const { ptyId } = terminal
    const processIncarnation = this.getTerminalProcessIncarnation(terminal.handle)
    const foreground = processIncarnation
      ? await this.orchestrationMailboxPointerDelivery.probeForeground(ptyId, processIncarnation)
      : null
    if (
      this.getTerminalProcessIncarnation(terminal.handle) !== processIncarnation ||
      this.orchestrationMailboxDeliveryTarget.resolveTerminal(mailbox)?.ptyId !== ptyId
    ) {
      return null
    }
    const agentName =
      tuiAgentDisplayName(this.mailDeliveryAgent(ptyId) ?? foreground?.agent ?? '') ?? 'The agent'
    const refusal = this.deliveryRefusal(
      ptyId,
      foreground?.foreground,
      undefined,
      foreground?.agent
    )
    if (
      foreground &&
      !this.orchestrationMailboxPointerDelivery.applyForeground(
        ptyId,
        foreground,
        foreground.foreground,
        refusal === null
      )
    ) {
      if (!followup) {
        return this.readTerminalMailHold(mailbox, true)
      }
      this.armDeliveryRecheck(ptyId, { foreground: true })
      return { kind: 'not-live', agentName }
    }
    this.armDeliveryRecheck(
      ptyId,
      foreground?.foreground === 'shell' ? { foreground: true } : undefined
    )
    return terminalMailHoldVerdict({
      refusal,
      foreground: foreground?.foreground,
      agentName,
      foregroundHeld: () => this.orchestrationMailboxPointerDelivery.isForegroundHeld(ptyId),
      takingInput: isMailboxTerminalTakingInput(terminal),
      agentInFront: foreground?.foreground === 'agent' && terminal.lastAgentStatusObservedLive,
      terminalHandle: terminal.handle
    })
  }

  /** Whether a waiting `check --wait` takes mail of this type stored for this mailbox, as arrival would. */
  hasMessageWaiterFor(mailbox: string, messageType: string): boolean {
    return [...(this.messageWaiters.get(mailbox) ?? [])].some(
      (waiter) => !waiter.typeFilter || waiter.typeFilter.includes(messageType)
    )
  }

  protected evaluateTuiIdleForPty(pty: RuntimePtyWorktreeRecord): TuiIdleVerdict {
    return evaluateTuiIdle(
      ptyTuiIdleEvidence(this.tuiIdleEvidenceSource, pty, () =>
        buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
      )
    )
  }

  protected getAdoptedPtyExplicitIdleStatus(pty: RuntimePtyWorktreeRecord): AgentStatus | null {
    const title = pty.lastOscTitle ?? this.getAdoptedPtyTitle(pty)
    return title ? detectExplicitIdleStatusFromTitle(title) : null
  }

  protected getAdoptedPtyTitle(pty: RuntimePtyWorktreeRecord): string | null {
    for (const leaf of this.leaves.values()) {
      if (leaf.ptyId !== pty.ptyId) {
        continue
      }
      const title = leaf.paneTitle ?? this.tabs.get(leaf.tabId)?.title
      if (!title) {
        continue
      }
      return title
    }
    return null
  }
}
