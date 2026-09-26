// What a send or a Stop needs from the session before the ledger places its row: the
// conversation open. Nothing here needs an owner — a send is accepted into the conversation and
// the delivery loop makes the session ready — so a refusal before acceptance is only one the
// conversation itself makes: a rewind or conversation command in doubt, a cleared conversation,
// or a journal that cannot be opened.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  refuse,
  type AgentSessionMutationEnvelope,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../shared/tui-agent-display-names'
import type { AgentSessionFailureTextContext } from './structured-agent-session-failure-text'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import {
  AGENT_SESSION_NOT_ATTACHED,
  type AgentSessionMutationSessionPreparation
} from './structured-agent-session-mutation-admission'
import { rewindRefusal } from './structured-rewind-refusal'

/** Why the record refuses any send right now, whoever owns it; null when a send may run. */
export function structuredAgentSessionSendBlock(
  record: AgentSessionRecord | null
): { ok: false; refusal: AgentSessionWireRefusal } | null {
  const rewind = record?.rewind
  if (rewind?.phase === 'prepared' || rewind?.phase === 'provider-succeeded') {
    return rewindRefusal('outcome-unknown')
  }
  const command = record?.conversationCommand
  if (
    command &&
    ((command.state === 'unknown' && command.phase === 'prepared') ||
      (command.command === 'clear' && command.replacementSessionId))
  ) {
    return {
      ok: false,
      refusal: command.replacementSessionId
        ? refuse(
            'agent_session_operation_invalid',
            'conversationCleared',
            'This conversation has been cleared. Use the current conversation.'
          )
        : refuse(
            'agent_session_operation_invalid',
            'conversationCommandUnconfirmed',
            'The conversation operation is unconfirmed.'
          )
    }
  }
  return null
}

/** The conversation a send or a Stop writes to, opened when this host holds it closed. */
export async function openConversationForWrite(
  openConversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession | null>,
  envelope: AgentSessionMutationEnvelope
): Promise<AgentSessionMutationSessionPreparation> {
  try {
    if (await openConversation(envelope.sessionId)) {
      return { ok: true }
    }
    return { ok: false, refusal: AGENT_SESSION_NOT_ATTACHED }
  } catch (error) {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_journal_unreadable',
        'journalUnreadable',
        `The conversation could not be opened: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
}

/** Who a failure sentence names: the chat's agent, when the record says. */
export function structuredAgentSessionFailureTextContext(
  record: AgentSessionRecord | null
): AgentSessionFailureTextContext {
  return record ? { agentName: TUI_AGENT_DISPLAY_NAMES[record.provider] } : {}
}
