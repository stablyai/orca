import { OrcaRuntimeWithBindPtyIncarnationHandle } from '../identity/terminal-handle-bindings'
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
import { mailboxDeliveryTuiVerdict, terminalDeliveryRefusal } from './terminal-delivery-refusal'
import { ptyTuiIdleEvidence } from './tui-idle-evidence-source'
import { TUI_IDLE_QUIESCENCE_MS } from './terminal-idle-policy'
import { USER_INPUT_HOLD_CAP_MS } from './claude-open-dialog-hold'
import {
  readTerminalComposerTypedText,
  type TerminalCursorContext
} from '../../../../shared/terminal/input/terminal-composer-draft'
import {
  MailboxDeliveryRecheck,
  type MailboxDeliveryDecision
} from '../../orchestration/mailbox/notifications/mailbox-delivery-recheck'
import type { MailboxForeground } from './launched-agent-foreground'
import {
  isMailboxTerminalTakingInput,
  type OrchestrationMailboxTerminal
} from '../../orchestration/mailbox/routing/mailbox-owner'
import { openCodeComposerHoldsDraft } from '../../../../shared/terminal/input/opencode-composer'
import { tuiAgentDisplayName } from '../../../../shared/agent-launch/catalog/tui-agent-display-names'
import { selectExplicitAgentIdentityRow } from '../../workspaces/process-listing/runtime-hook-agent-row-selection'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import type { MailboxDeliveryHold } from '../../orchestration/mailbox/delivery-hold/mailbox-delivery-hold'

const DIALOG_HOLD_RECHECK_MS = 2000

export abstract class OrcaRuntimeWithResolveExitWaiters extends OrcaRuntimeWithBindPtyIncarnationHandle {
  protected resolvePtyExitWaiters(pty: RuntimePtyWorktreeRecord, ptyId: string): void {
    for (const waiter of this.terminalWaiters.forPty(ptyId)) {
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
      } else if (verdict.kind === 'ready-strong') {
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
      held: (ptyId) => this.orchestrationMailboxPointerDelivery.isForegroundHeld(ptyId),
      hasMail: (terminal) => this.orchestrationMailboxNotifications.hasDeliverableMail(terminal),
      readinessDelay: (terminal) => {
        if (!isMailboxTerminalTakingInput(terminal)) {
          return null
        }
        const outputAt = this.readOutputClockAt(terminal.ptyId)
        const remaining = outputAt === null ? 0 : TUI_IDLE_QUIESCENCE_MS - (Date.now() - outputAt)
        return this.ptyDeliveryHold(terminal.ptyId) !== null || remaining <= 0
          ? DIALOG_HOLD_RECHECK_MS
          : remaining + 50
      },
      deliver: (ptyId) => this.deliverPendingMessagesForPty(ptyId)
    }
  )

  protected deliverPendingMessagesForPty(ptyId: string): void {
    const terminal = this.getOrchestrationMailboxTerminal(ptyId)
    if (
      terminal &&
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
    this.deliveryRechecks.request(ptyId, decision)
  }

  protected readMailboxForeground(ptyId: string): Promise<MailboxForeground> {
    const terminal = this.getOrchestrationMailboxTerminal(ptyId)
    if (!terminal || !this.orchestrationMailboxNotifications.hasDeliverableMail(terminal)) {
      return Promise.resolve('unknown')
    }
    const agent = this.mailDeliveryAgent(ptyId)
    return this.inspectMailboxForeground(ptyId, isTuiAgent(agent) ? agent : undefined)
  }

  protected isMailboxForegroundCandidate(terminal: OrchestrationMailboxTerminal): boolean {
    return (
      terminal.lastAgentStatus === null &&
      terminal.lastAgentStatusObservedLive &&
      isTuiAgent(this.mailDeliveryAgent(terminal.ptyId))
    )
  }

  protected mailboxTerminalAdmission(
    terminal: OrchestrationMailboxTerminal,
    foreground?: MailboxForeground,
    stagedText?: string
  ): OrchestrationMailboxTerminal {
    return terminal.lastAgentStatus === null &&
      foreground === 'agent' &&
      terminal.lastAgentStatusObservedLive &&
      this.deliveryRefusal(terminal.ptyId, foreground, stagedText) === null
      ? { ...terminal, lastAgentStatus: 'idle' }
      : terminal
  }

  /** Pointer plus Enter takes the waits' readiness ranking, plus a working verdict: agents queue or
   *  steer text sent mid-turn, so only dialogs, drafts and unsettled terminals hold mail. Callers
   *  separately require live status evidence. */
  protected isAgentSettledForDelivery(
    ptyId: string,
    foreground?: MailboxForeground,
    stagedText?: string
  ): boolean {
    return this.deliveryRefusal(ptyId, foreground, stagedText) === null
  }

  /** Why delivery would hold mail for this worker terminal now, for a send receipt: the gate's own reason. */
  async readTerminalMailHold(
    terminalHandle: string,
    followup = false
  ): Promise<MailboxDeliveryHold | null> {
    const terminal = this.orchestrationMailboxDeliveryTarget.resolveTerminal(terminalHandle)
    const ptyId = terminal?.ptyId
    if (!ptyId) {
      return null
    }
    const processIncarnation = this.getTerminalProcessIncarnation(terminal.handle)
    const foreground = processIncarnation
      ? await this.orchestrationMailboxPointerDelivery.probeForeground(ptyId, processIncarnation)
      : null
    if (
      this.getTerminalProcessIncarnation(terminal.handle) !== processIncarnation ||
      this.orchestrationMailboxDeliveryTarget.resolveTerminal(terminalHandle)?.ptyId !== ptyId
    ) {
      return null
    }
    const agentName = tuiAgentDisplayName(this.mailDeliveryAgent(ptyId) ?? '') ?? 'The agent'
    const refusal = this.deliveryRefusal(ptyId, foreground?.foreground)
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
        return this.readTerminalMailHold(terminalHandle, true)
      }
      this.armDeliveryRecheck(ptyId, { foreground: true })
      return { kind: 'not-live', agentName }
    }
    this.armDeliveryRecheck(
      ptyId,
      foreground?.foreground === 'shell' ? { foreground: true } : undefined
    )
    if (refusal === 'no-terminal') {
      return null
    }
    if (refusal && ['prompt', 'draft', 'restoring'].includes(refusal.kind)) {
      return refusal
    }
    if (foreground?.foreground === 'shell') {
      return { kind: 'not-foreground', agentName }
    }
    if (this.orchestrationMailboxPointerDelivery.isForegroundHeld(ptyId)) {
      return { kind: 'not-live', agentName }
    }
    return !terminal.lastAgentStatusObservedLive ? { kind: 'not-live', agentName } : refusal
  }

  private deliveryRefusal(
    ptyId: string,
    foreground?: MailboxForeground,
    stagedText?: string
  ): MailboxDeliveryHold | 'no-terminal' | null {
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      return 'no-terminal'
    }
    const hold = this.ptyDeliveryHold(ptyId, stagedText)
    if (hold) {
      return { kind: hold }
    }
    return terminalDeliveryRefusal({
      ...this.deliveryTuiVerdict(pty, foreground, stagedText),
      recognizedAgent: !!this.mailDeliveryAgent(ptyId)
    })
  }

  private mailDeliveryHookAgent(ptyId: string) {
    const join = this.readHookRowJoinForPty(ptyId)
    const row = join ? selectExplicitAgentIdentityRow(join) : null
    const floor = this.agentPromptExplicitStatusFloorByPtyId.get(ptyId)
    return row && (floor === undefined || row.receivedAt > floor) ? row.agentType : null
  }

  private mailDeliveryAgent(ptyId: string) {
    return this.getPaneTerminalAgent(ptyId) ?? this.mailDeliveryHookAgent(ptyId) ?? null
  }

  private deliveryTuiVerdict(
    pty: RuntimePtyWorktreeRecord,
    foreground?: MailboxForeground,
    stagedText?: string
  ) {
    const agent = this.mailDeliveryAgent(pty.ptyId)
    return mailboxDeliveryTuiVerdict(
      { ...this.tuiIdleEvidenceSource, getPaneAgent: () => (isTuiAgent(agent) ? agent : null) },
      pty,
      () => buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview),
      pty.lastAgentStatus === null && foreground === 'agent',
      () =>
        readTerminalComposerTypedText(
          this.readWholeScreenModel(pty.ptyId)?.emulator.getCursorLineContext()
        ),
      stagedText
    )
  }

  /** An unsent draft would be submitted with the injected text; the cap bounds an abandoned or misread one.
   *  Typed text only: an agent's dim prompt suggestion is not the user's draft (#38015). */
  private ptyDeliveryHold(
    ptyId: string,
    stagedText?: string
  ): 'prompt' | 'draft' | 'restoring' | null {
    if (this.isPtyAwaitingUserInput(ptyId)) {
      return 'prompt'
    }
    const facts = this.terminalRunFacts
    const state = this.readWholeScreenModel(ptyId)
    const context = state?.emulator.getCursorLineContext()
    const ownPointer =
      stagedText !== undefined && readTerminalComposerTypedText(context) === stagedText
    const draft = !!context && !ownPointer && this.hasComposerDraft(ptyId, context)
    const drivingInputAt = facts.readLastDrivingInputAt(ptyId)
    const unattributed = drivingInputAt === null && facts.readProcessStartedAt(ptyId) === null
    // Why: main saw every input to a process it started, so with no typing there the draft is Orca's
    // launch text; a process it attached to, as after a restart, may hold one typed before, which a
    // screen still restoring cannot rule out yet.
    const restoring = !state && this.headlessHydrationState.get(ptyId) === 'pending'
    const unattributedSince = facts.noteUnattributedDraft(
      ptyId,
      unattributed && (draft || restoring)
    )
    const holdSince = drivingInputAt ?? unattributedSince
    const holding =
      (draft || (unattributed && restoring)) &&
      holdSince !== null &&
      Date.now() - holdSince <= USER_INPUT_HOLD_CAP_MS
    return holding ? (draft ? 'draft' : 'restoring') : null
  }

  // Why: OpenCode's composer has no prompt glyph, so only its own pane is read with its box layout.
  private hasComposerDraft(ptyId: string, context: TerminalCursorContext | null): boolean {
    const agent = this.getPaneTerminalAgent(ptyId)
    return (agent === 'opencode' || agent === 'opencode2') && context
      ? openCodeComposerHoldsDraft(context)
      : !!readTerminalComposerTypedText(context)
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
