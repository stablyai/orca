import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { OrcaRuntimeWithBindPtyIncarnationHandle } from '../identity/terminal-handle-bindings'
import { buildTerminalWaitText } from './terminal-wait-tail-state'
import {
  mailboxDeliveryRefusal,
  mailboxComposerHoldsDraft,
  terminalComposerTextOwnsPointer
} from './terminal-delivery-refusal'
import { USER_INPUT_HOLD_CAP_MS } from './claude-open-dialog-hold'
import type { MailboxForeground } from './launched-agent-foreground'
import { tuiAgentDisplayName } from '../../../../shared/agent-launch/catalog/tui-agent-display-names'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import type { MailboxDeliveryHold } from '../../orchestration/mailbox/delivery-hold/mailbox-delivery-hold'

/** Why orchestration mail would not be typed into a terminal now: a prompt, a draft, or the agent's own state. */
export abstract class OrcaRuntimeWithMailDeliveryRefusal extends OrcaRuntimeWithBindPtyIncarnationHandle {
  protected deliveryRefusal(
    ptyId: string,
    foreground?: MailboxForeground,
    stagedText?: string,
    candidate?: TuiAgent
  ): MailboxDeliveryHold | 'no-terminal' | null {
    const pty = this.ptysById.get(ptyId)
    if (!pty) {
      return 'no-terminal'
    }
    const pointerText = this.orchestrationMailboxPointerDelivery.stagedPointerText(ptyId)
    stagedText ??= pointerText
    const agent = this.mailDeliveryAgent(ptyId) ?? candidate
    if (candidate && agent !== candidate) {
      return { kind: 'not-live', agentName: tuiAgentDisplayName(agent ?? '') ?? 'The agent' }
    }
    const hold = this.ptyDeliveryHold(ptyId, stagedText, candidate)
    if (hold) {
      return { kind: hold }
    }
    return mailboxDeliveryRefusal(
      { ...this.tuiIdleEvidenceSource, getPaneAgent: () => (isTuiAgent(agent) ? agent : null) },
      pty,
      () => buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview),
      this.orchestrationMailboxPointerDelivery.requiresCurrentScreen(ptyId) ||
        (pty.lastAgentStatus === null && (foreground === 'agent' || pointerText !== undefined)),
      () => this.readMailboxComposerText(pty.ptyId, candidate),
      !!agent,
      stagedText
    )
  }

  /** An unsent draft would be submitted with the injected text; the cap bounds an abandoned or misread one.
   *  Typed text only: an agent's dim prompt suggestion is not the user's draft (#38015). */
  protected ptyDeliveryHold(
    ptyId: string,
    stagedText = this.orchestrationMailboxPointerDelivery.stagedPointerText(ptyId),
    candidate?: TuiAgent
  ): 'prompt' | 'draft' | 'restoring' | null {
    if (this.isPtyAwaitingUserInput(ptyId)) {
      return 'prompt'
    }
    const facts = this.terminalRunFacts
    const state = this.readWholeScreenModel(ptyId)
    const context = state?.emulator.getCursorLineContext()
    const draft =
      !!context &&
      !terminalComposerTextOwnsPointer(
        this.readMailboxComposerText(ptyId, candidate),
        stagedText
      ) &&
      mailboxComposerHoldsDraft(this.mailDeliveryAgent(ptyId) ?? candidate ?? null, context)
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
}
