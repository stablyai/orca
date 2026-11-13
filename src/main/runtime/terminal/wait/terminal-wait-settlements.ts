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
import { terminalDeliveryRefusal } from './terminal-delivery-refusal'
import { ptyTuiIdleEvidence } from './tui-idle-evidence-source'
import { TUI_IDLE_QUIESCENCE_MS } from './terminal-idle-policy'
import { USER_INPUT_HOLD_CAP_MS } from './claude-open-dialog-hold'
import {
  readTerminalComposerTypedText,
  type TerminalCursorContext
} from '../../../../shared/terminal/input/terminal-composer-draft'
import { openCodeComposerHoldsDraft } from '../../../../shared/terminal/input/opencode-composer'
import { isMailboxTerminalTakingInput } from '../../orchestration/mailbox/routing/mailbox-owner'
import { tuiAgentDisplayName } from '../../../../shared/agent-launch/catalog/tui-agent-display-names'
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

  /** Point a terminal at its mail once it takes input and is settled; refusal re-arms the recheck. */
  protected deliverPendingMessagesForPty(ptyId: string): void {
    if (this.orchestrationMailboxPointerDelivery.isForegroundHeld(ptyId)) {
      this.clearDeliveryRecheck(ptyId)
      return
    }
    const terminal = this.getOrchestrationMailboxTerminal(ptyId)
    if (
      terminal &&
      isMailboxTerminalTakingInput(terminal) &&
      this.checkDeliverySettledAndArmRecheck(ptyId)
    ) {
      this.orchestrationMailboxNotifications.deliverForTerminal(terminal)
    }
  }

  /** Edge-driven delivery needs a one-shot recheck when quiet evidence may later settle; otherwise hookless agents can strand queued mail without another title/graph/message edge. */
  protected checkDeliverySettledAndArmRecheck(ptyId: string): boolean {
    if (this.isAgentSettledForDelivery(ptyId)) {
      this.clearDeliveryRecheck(ptyId)
      return true
    }
    this.armDeliveryRecheck(ptyId)
    return false
  }

  protected clearDeliveryRecheck(ptyId: string): void {
    const timer = this.deliveryRecheckTimersByPtyId.get(ptyId)
    if (timer) {
      clearTimeout(timer)
      this.deliveryRecheckTimersByPtyId.delete(ptyId)
    }
  }

  private armDeliveryRecheck(ptyId: string): void {
    if (this.deliveryRecheckTimersByPtyId.has(ptyId)) {
      return
    }
    // Refusal can lift without another edge (hook deadlines, foreground recognition), but only waiting work needs the retry.
    const terminal = this.getOrchestrationMailboxTerminal(ptyId)
    if (!terminal || !this.orchestrationMailboxNotifications.hasDeliverableMail(terminal)) {
      return
    }
    // Schedule just beyond the quiet window and re-arm from fresher output if still streaming.
    const outputAt = this.readOutputClockAt(ptyId)
    const quietRemainingMs =
      outputAt === null ? 0 : TUI_IDLE_QUIESCENCE_MS - (Date.now() - outputAt)
    // A dialog or draft lifts only when the user acts, so poll it slowly rather than at 20 Hz.
    const delay =
      this.ptyDeliveryHold(ptyId) !== null || quietRemainingMs <= 0
        ? DIALOG_HOLD_RECHECK_MS
        : quietRemainingMs + 50
    const timer = setTimeout(() => {
      this.deliveryRecheckTimersByPtyId.delete(ptyId)
      // Delivery rechecks settlement first; the agent may have become busy again.
      this.deliverPendingMessagesForPty(ptyId)
    }, delay)
    timer.unref?.()
    this.deliveryRecheckTimersByPtyId.set(ptyId, timer)
  }

  /** Pointer plus Enter takes the waits' readiness ranking, plus a working verdict: agents queue or
   *  steer text sent mid-turn, so only dialogs, drafts and unsettled terminals hold mail. Callers
   *  separately require live status evidence. */
  protected isAgentSettledForDelivery(ptyId: string): boolean {
    return this.deliveryRefusal(ptyId) === null
  }

  /** Why delivery would hold mail for this worker terminal now, for a send receipt: the gate's own reason. */
  async readTerminalMailHold(terminalHandle: string): Promise<MailboxDeliveryHold | null> {
    const terminal = this.orchestrationMailboxDeliveryTarget.resolveTerminal(terminalHandle)
    const ptyId = terminal?.ptyId
    if (!ptyId) {
      return null
    }
    const incarnation = this.ptysById.get(ptyId)?.incarnationId
    const foreground = await this.orchestrationMailboxPointerDelivery.probeForeground(ptyId)
    if (
      this.ptysById.get(ptyId)?.incarnationId !== incarnation ||
      this.orchestrationMailboxDeliveryTarget.resolveTerminal(terminalHandle)?.ptyId !== ptyId
    ) {
      return null
    }
    if (foreground === 'shell' && incarnation) {
      this.orchestrationMailboxPointerDelivery.holdForeground(ptyId)
      this.clearDeliveryRecheck(ptyId)
    }
    const agent = this.getPaneTerminalAgent(ptyId)
    const agentName = (agent && tuiAgentDisplayName(agent)) || 'The agent'
    if (this.orchestrationMailboxPointerDelivery.isForegroundHeld(ptyId)) {
      return { kind: 'not-foreground', agentName }
    }
    if (!terminal.lastAgentStatusObservedLive) {
      return { kind: 'not-live', agentName }
    }
    const refusal = this.deliveryRefusal(ptyId)
    return refusal === 'no-terminal' ? null : refusal
  }

  private deliveryRefusal(ptyId: string): MailboxDeliveryHold | 'no-terminal' | null {
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      return 'no-terminal'
    }
    const hold = this.ptyDeliveryHold(ptyId)
    if (hold) {
      return { kind: hold }
    }
    const { verdict, readScreenInputVeto } = this.deliveryTuiVerdict(pty)
    return terminalDeliveryRefusal({
      verdict,
      recognizedAgent: !!this.getPaneTerminalAgent(ptyId),
      readScreenInputVeto
    })
  }

  private deliveryTuiVerdict(pty: RuntimePtyWorktreeRecord) {
    const evidence = ptyTuiIdleEvidence(this.tuiIdleEvidenceSource, pty, () =>
      buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
    )
    // Why no blocked reader: a refusal here re-arms a recheck that a lingering tail prompt
    // would spin, so delivery keeps its own, blocked-blind, reading of the same ranking.
    const verdict = evaluateTuiIdle({ ...evidence, readTailBlockedReason: () => null })
    return { verdict, readScreenInputVeto: evidence.readScreenInputVeto }
  }

  protected mailWakeShellOccupied(ptyId: string): boolean {
    const screen = this.readWholeScreenModel(ptyId)
    return (
      !screen ||
      this.isPtyAwaitingUserInput(ptyId) ||
      this.hasComposerDraft(ptyId, screen.emulator.getCursorLineContext())
    )
  }

  /** An unsent draft would be submitted with the injected text; the cap bounds an abandoned or misread one.
   *  Typed text only: an agent's dim prompt suggestion is not the user's draft (#38015). */
  private ptyDeliveryHold(ptyId: string): 'prompt' | 'draft' | 'restoring' | null {
    if (this.isPtyAwaitingUserInput(ptyId)) {
      return 'prompt'
    }
    const facts = this.terminalRunFacts
    const state = this.readWholeScreenModel(ptyId)
    const draft = !!state && this.hasComposerDraft(ptyId, state.emulator.getCursorLineContext())
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
