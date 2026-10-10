// Identity and append plumbing shared by the ZCode journal translators.
//
// ZCode's protocol is session-scoped, so item identities use the `legacy` arm
// keyed by the provider's own message, part, and turn ids — the session id rides
// the arm's empty field because the whole child is one session.

import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity,
  AgentJournalTurnScope
} from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { ZcodeJournalTranslationAdmission } from './zcode-structured-journal-translation'
import { ZCODE_JOURNAL_ADMITTED } from './zcode-structured-journal-translation'

export function zcodeItemIdentity(recordId: string): AgentJournalItemIdentity {
  return { provider: 'legacy', agent: 'zcode', sessionId: '', recordId }
}

export function zcodeTurnIdentity(turnId: string): AgentJournalItemIdentity {
  return zcodeItemIdentity(`turn-lifecycle:${turnId}`)
}

export function zcodeMessageIdentity(messageId: string): AgentJournalItemIdentity {
  return zcodeItemIdentity(`message:${messageId}`)
}

export function zcodeToolIdentity(messageId: string, partId: string): AgentJournalItemIdentity {
  return zcodeItemIdentity(`tool:${messageId}:${partId}`)
}

/** Appends one item and publishes it, honoring the sink's non-blocking variants. */
export function appendZcodeItemAndPublish(
  sink: StructuredAgentSessionEventSink,
  identity: AgentJournalItemIdentity,
  body: AgentJournalItemBody,
  turnScope: AgentJournalTurnScope,
  options: { lifecycle?: boolean; observedAt?: number; coalescingKey?: string } = {}
): ZcodeJournalTranslationAdmission {
  const admission = sink.tryAppendItem
    ? sink.tryAppendItem(identity, body, {
        turnScope,
        ...(options.lifecycle ? { lifecycle: true } : {}),
        ...(options.observedAt !== undefined ? { observedAt: options.observedAt } : {})
      })
    : (sink.appendItem(
        identity,
        body,
        options.observedAt !== undefined
          ? { turnScope, observedAt: options.observedAt }
          : { turnScope }
      ),
      ZCODE_JOURNAL_ADMITTED)
  if (!admission.accepted) {
    return admission
  }
  return sink.tryPublish
    ? sink.tryPublish({
        ...(options.lifecycle ? { lifecycle: true } : {}),
        ...(options.coalescingKey ? { coalescingKey: options.coalescingKey } : {})
      })
    : ZCODE_JOURNAL_ADMITTED
}
