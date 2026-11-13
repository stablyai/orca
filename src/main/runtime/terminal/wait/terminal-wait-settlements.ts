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
import { isMailboxTerminalTakingInput } from '../../orchestration/mailbox/routing/mailbox-owner'
import { openCodeComposerHoldsDraft } from '../../../../shared/terminal/input/opencode-composer'
import { tuiAgentDisplayName } from '../../../../shared/agent-launch/catalog/tui-agent-display-names'
import { selectFreshExplicitAgentStatusRow } from '../../workspaces/process-listing/runtime-hook-agent-row-selection'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import type { MailboxDeliveryHold } from '../../orchestration/mailbox/delivery-hold/mailbox-delivery-hold'

const DIALOG_HOLD_RECHECK_MS = 2000
const FOREGROUND_HOLD_RECHECK_MS = 5000

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
    const terminal = this.getOrchestrationMailboxTerminal(ptyId)
    if (
      terminal &&
      this.orchestrationMailboxNotifications.hasDeliverableMail(terminal) &&
      (this.orchestrationMailboxPointerDelivery.isForegroundHeld(ptyId) ||
        (isMailboxTerminalTakingInput(terminal) && this.isAgentSettledForDelivery(ptyId)))
    ) {
      this.orchestrationMailboxNotifications.deliverForTerminal(terminal)
    }
    this.armDeliveryRecheck(ptyId)
  }

  protected checkDeliverySettledAndArmRecheck(ptyId: string): boolean {
    const settled = this.isAgentSettledForDelivery(ptyId)
    if (!settled) {
      this.armDeliveryRecheck(ptyId)
    }
    return settled
  }

  protected clearDeliveryRecheck(ptyId: string): void {
    const timer = this.deliveryRecheckTimersByPtyId.get(ptyId)
    if (timer) {
      clearTimeout(timer)
      this.deliveryRecheckTimersByPtyId.delete(ptyId)
    }
  }

  protected readMailboxForeground(ptyId: string): Promise<'agent' | 'shell' | 'unknown'> {
    const terminal = this.getOrchestrationMailboxTerminal(ptyId)
    return terminal && this.orchestrationMailboxNotifications.hasDeliverableMail(terminal)
      ? this.readLaunchedAgentForeground(ptyId)
      : Promise.resolve('unknown')
  }

  protected armDeliveryRecheck(ptyId: string): void {
    // Refusal can lift without another edge (hook deadlines, foreground recognition), but only waiting work needs the retry.
    const terminal = this.getOrchestrationMailboxTerminal(ptyId)
    if (
      !terminal ||
      !this.orchestrationMailboxNotifications.hasDeliverableMail(terminal) ||
      this.orchestrationMailboxPointerDelivery.isDeliveryInFlight(ptyId)
    ) {
      this.clearDeliveryRecheck(ptyId)
      return
    }
    const foregroundHeld = this.orchestrationMailboxPointerDelivery.isForegroundHeld(ptyId)
    if (this.deliveryRecheckTimersByPtyId.has(ptyId)) {
      return
    }
    this.clearDeliveryRecheck(ptyId)
    // Schedule just beyond the quiet window and re-arm from fresher output if still streaming.
    const outputAt = this.readOutputClockAt(ptyId)
    const quietRemainingMs =
      outputAt === null ? 0 : TUI_IDLE_QUIESCENCE_MS - (Date.now() - outputAt)
    // A dialog or draft lifts only when the user acts, so poll it slowly rather than at 20 Hz.
    // Spread suspended terminals across the next second instead of inspecting a fleet in one burst.
    const staggerMs = [...ptyId].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 1000, 0)
    const delay = foregroundHeld
      ? FOREGROUND_HOLD_RECHECK_MS + staggerMs
      : this.ptyDeliveryHold(ptyId) !== null || quietRemainingMs <= 0
        ? DIALOG_HOLD_RECHECK_MS
        : quietRemainingMs + 50
    const timer = setTimeout(() => {
      this.deliveryRecheckTimersByPtyId.delete(ptyId)
      const current = this.getOrchestrationMailboxTerminal(ptyId)
      if (current && this.orchestrationMailboxNotifications.hasDeliverableMail(current)) {
        this.deliverPendingMessagesForPty(ptyId)
      }
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
    if (
      foreground &&
      !this.orchestrationMailboxPointerDelivery.applyForeground(
        ptyId,
        foreground,
        foreground.foreground
      )
    ) {
      return this.readTerminalMailHold(terminalHandle)
    }
    this.armDeliveryRecheck(ptyId)
    const knownAgent = this.mailDeliveryAgent(ptyId)
    const agentName =
      (knownAgent && isTuiAgent(knownAgent) ? tuiAgentDisplayName(knownAgent) : null) || 'The agent'
    const refusal = this.deliveryRefusal(ptyId)
    if (refusal === 'no-terminal') {
      return null
    }
    if (refusal && ['prompt', 'draft', 'restoring'].includes(refusal.kind)) {
      return refusal
    }
    if (foreground?.foreground === 'shell') {
      return { kind: 'not-foreground', agentName }
    }
    return !terminal.lastAgentStatusObservedLive ? { kind: 'not-live', agentName } : refusal
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
      recognizedAgent: !!this.mailDeliveryAgent(ptyId),
      readScreenInputVeto
    })
  }

  private mailDeliveryAgent(ptyId: string) {
    const join = this.readHookRowJoinForPty(ptyId)
    return (
      this.getPaneTerminalAgent(ptyId) ??
      (join ? selectFreshExplicitAgentStatusRow(join)?.agentType : null)
    )
  }

  private deliveryTuiVerdict(pty: RuntimePtyWorktreeRecord) {
    const agent = this.mailDeliveryAgent(pty.ptyId)
    const source = {
      ...this.tuiIdleEvidenceSource,
      getPaneAgent: () => (isTuiAgent(agent) ? agent : null)
    }
    const terminal = this.getOrchestrationMailboxTerminal(pty.ptyId)
    const record = { ...pty, lastAgentStatus: terminal?.lastAgentStatus ?? pty.lastAgentStatus }
    const evidence = ptyTuiIdleEvidence(source, record, () =>
      buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
    )
    // Why no blocked reader: a refusal here re-arms a recheck that a lingering tail prompt
    // would spin, so delivery keeps its own, blocked-blind, reading of the same ranking.
    const verdict = evaluateTuiIdle({ ...evidence, readTailBlockedReason: () => null })
    return { verdict, readScreenInputVeto: evidence.readScreenInputVeto }
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
