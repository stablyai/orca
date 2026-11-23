import type { ChatMailPlace } from '../../../shared/connectors/external-conversation-link'
import type { AgentMessageSource } from '../../../shared/agent-session/journal/agent-session-message-source'
import type { createStructuredMailboxPointerHost } from '../orchestration/mailbox/structured-pointer/structured-mailbox-pointer-host'
import type {
  StructuredMailFollowUp,
  StructuredMailMessageVerifier,
  StructuredMailReportItem
} from '../orchestration/mailbox/structured-pointer/structured-mailbox-pointer-host-contract'
import { RuntimeConstructionServices } from './runtime-construction-services'

/** Bot hooks the construction classes call; later runtime classes implement them. */
export abstract class RuntimeBotConstructionHooks extends RuntimeConstructionServices {
  abstract ensureStructuredAgentSessionHost(): Promise<void>

  // Group rules for group sessions' mail; read lazily, as the base builds its mail delivery first.
  protected structuredMailOwner?(): Parameters<typeof createStructuredMailboxPointerHost>[0]

  // What a chat's mail offers in place of `[Reply:]`, by the rule `reply` applies to bot mail.
  protected structuredMailReplyFollowUp?: StructuredMailFollowUp

  // The open item a finished worker's report was started for, from this host's item store.
  protected structuredMailReportItem?: StructuredMailReportItem

  // Live work-target provenance verification for whole-mail chat push delivery.
  protected structuredMailVerifyMessage?: StructuredMailMessageVerifier

  // The chat's bound conversation and whether its answer to this mail lands there; null if unbound.
  protected chatConversationPlace?(
    sessionId: string,
    from: AgentMessageSource
  ): ChatMailPlace | null
}
