// What a send or a Stop needs from the session before the ledger places its row: the
// conversation open. Nothing here needs an owner — a send is accepted into the conversation and
// the delivery loop makes the session ready — so a refusal before acceptance is only one the
// conversation itself makes: a rewind or conversation command in doubt, a cleared conversation,
// or a journal that cannot be opened.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import type { AgentSessionWireRefusalCode } from '../../../shared/agent-session-wire-refusals'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../shared/tui-agent-display-names'
import {
  ownerRestartFailedOutcome,
  providerStartupFailureOutcome
} from './structured-agent-session-dead-generation-settlement'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import {
  AGENT_SESSION_NOT_ATTACHED,
  type AgentSessionMutationSessionPreparation
} from './structured-agent-session-mutation-admission'
import { rewindRefusal } from './structured-rewind-refusal'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'

/**
 * Whether a refused start leaves the chat anything to start again from. `unresumable`: this host
 * has nothing to restart it from — no record, or none it can run — so only a new chat continues.
 * A new wire code does not compile until it is classified here.
 */
const START_REFUSAL_RESUMABLE: Record<AgentSessionWireRefusalCode, boolean> = {
  execution_owner_reconciling: true,
  agent_session_conflict: true,
  agent_session_checkpoint_stale: true,
  agent_session_ownership_unknown: true,
  agent_session_operation_capacity: true,
  structured_agent_session_unsupported: false,
  agent_session_operation_conflict: true,
  agent_session_operation_expired: true,
  agent_session_operation_invalid: true,
  agent_session_operation_unknown: true,
  agent_session_item_revision_stale: true,
  agent_session_already_resolved: true,
  agent_session_identity_required: false,
  agent_session_journal_unreadable: true,
  agent_session_owner_restart_failed: true
}

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
      refusal: {
        code: 'agent_session_operation_invalid',
        message: command.replacementSessionId
          ? 'This conversation has been cleared. Use the current conversation.'
          : 'The conversation operation is unconfirmed.'
      }
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
      refusal: {
        code: 'agent_session_journal_unreadable',
        message: `The conversation could not be opened: ${
          error instanceof Error ? error.message : String(error)
        }`
      }
    }
  }
}

/** The conversation a write lands in, opened when this host holds it closed. */
export function openForWrite(
  context: Pick<StructuredAgentSessionMutationContext, 'openConversation'>,
  envelope: AgentSessionMutationEnvelope
): () => Promise<AgentSessionMutationSessionPreparation> {
  return () => openConversationForWrite(context.openConversation, envelope)
}

/** For an operation only the provider can perform: the conversation, then its agent. */
export function openWithAgent(
  context: Pick<StructuredAgentSessionMutationContext, 'openConversation' | 'ensureAgent'>,
  envelope: AgentSessionMutationEnvelope
): () => Promise<AgentSessionMutationSessionPreparation> {
  return async () => {
    const opened = await openConversationForWrite(context.openConversation, envelope)
    return opened.ok ? context.ensureAgent(envelope.sessionId) : opened
  }
}

/** A rewind still in doubt once the conversation is open is one only its provider can settle —
 *  the open settles every other — so a send starts the agent, whose attach recovers it. */
export function sendPreparation(
  context: Pick<StructuredAgentSessionMutationContext, 'openConversation' | 'ensureAgent' | 'deps'>,
  envelope: AgentSessionMutationEnvelope
): () => Promise<AgentSessionMutationSessionPreparation> {
  return async () => {
    const opened = await openConversationForWrite(context.openConversation, envelope)
    const phase = context.deps.store.getRecord(envelope.sessionId)?.rewind?.phase
    return opened.ok && (phase === 'prepared' || phase === 'provider-succeeded')
      ? context.ensureAgent(envelope.sessionId)
      : opened
  }
}

/** What the chat says, in its row and on every message it rejects, when the delivery loop could
 *  not make the session ready. A child that died starting reads as any start that died does. */
export function structuredAgentSessionStartFailureText(
  record: AgentSessionRecord | null,
  cause: AgentSessionWireRefusal
): string {
  if (cause.ownerVerdict === 'exited') {
    return providerStartupFailureOutcome(cause.message)
  }
  return ownerRestartFailedOutcome({
    agentName: record ? TUI_AGENT_DISPLAY_NAMES[record.provider] : 'The agent',
    reason: cause.message,
    resumable: START_REFUSAL_RESUMABLE[cause.code]
  })
}
