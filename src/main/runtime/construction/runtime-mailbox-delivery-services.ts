import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { OrchestrationMailboxPointerSubmitTarget } from '../orchestration/mailbox/terminal-pointer/mailbox-pointer-submit'
import type {
  MailboxForeground,
  MailboxForegroundInspection
} from '../terminal/wait/launched-agent-foreground'
import type { MailboxDeliveryDecision } from '../orchestration/mailbox/notifications/mailbox-delivery-recheck'
import type { OrchestrationMailboxTerminal } from '../orchestration/mailbox/routing/mailbox-owner'

export abstract class RuntimeMailboxDeliveryServices {
  protected abstract mailDeliveryAgent(ptyId: string): string | null | undefined
  protected abstract publishUncertainTerminalMail(ptyId: string, mailboxes: readonly string[]): void
  protected abstract resolveOrchestrationPointerSubmitTarget(
    ptyId: string,
    foreground?: MailboxForeground,
    stagedText?: string,
    agent?: TuiAgent
  ): OrchestrationMailboxPointerSubmitTarget | null

  protected abstract isAgentSettledForDelivery(
    ptyId: string,
    foreground?: MailboxForeground,
    stagedText?: string,
    agent?: TuiAgent
  ): boolean
  protected abstract isMailboxForegroundCandidate(terminal: OrchestrationMailboxTerminal): boolean
  protected abstract mailboxTerminalAdmission(
    terminal: OrchestrationMailboxTerminal,
    foreground?: MailboxForeground,
    stagedText?: string,
    agent?: TuiAgent
  ): OrchestrationMailboxTerminal
  protected abstract deliverPendingMessagesForPty(ptyId: string): void
  protected abstract needsMailboxForegroundEvaluation(ptyId: string): boolean
  protected abstract armDeliveryRecheck(ptyId: string, decision?: MailboxDeliveryDecision): void
  protected abstract readMailboxComposerText(ptyId: string, agent?: TuiAgent): string | null
  protected abstract readMailboxForeground(
    ptyId: string,
    agent?: TuiAgent
  ): Promise<MailboxForeground | MailboxForegroundInspection>
}
