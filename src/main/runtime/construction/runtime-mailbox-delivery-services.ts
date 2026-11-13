import type { OrchestrationMailboxPointerSubmitTarget } from '../orchestration/mailbox/terminal-pointer/mailbox-pointer-submit'
import type { MailboxForeground } from '../terminal/wait/launched-agent-foreground'
import type { MailboxDeliveryDecision } from '../orchestration/mailbox/notifications/mailbox-delivery-recheck'
import type { OrchestrationMailboxTerminal } from '../orchestration/mailbox/routing/mailbox-owner'

export abstract class RuntimeMailboxDeliveryServices {
  protected abstract resolveOrchestrationPointerSubmitTarget(
    ptyId: string,
    foreground?: MailboxForeground,
    stagedText?: string
  ): OrchestrationMailboxPointerSubmitTarget | null

  protected abstract isAgentSettledForDelivery(
    ptyId: string,
    foreground?: MailboxForeground,
    stagedText?: string
  ): boolean
  protected abstract isMailboxForegroundCandidate(terminal: OrchestrationMailboxTerminal): boolean
  protected abstract mailboxTerminalAdmission(
    terminal: OrchestrationMailboxTerminal,
    foreground?: MailboxForeground,
    stagedText?: string
  ): OrchestrationMailboxTerminal
  protected abstract deliverPendingMessagesForPty(ptyId: string): void
  protected abstract needsMailboxForegroundEvaluation(ptyId: string): boolean
  protected abstract armDeliveryRecheck(ptyId: string, decision?: MailboxDeliveryDecision): void
  protected abstract readMailboxForeground(ptyId: string): Promise<MailboxForeground>
}
