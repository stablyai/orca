// What a send or a Stop needs from the session before the ledger places its row: the
// conversation open. Nothing here needs an owner — a send is accepted into the conversation and
// the delivery loop makes the session ready — so a refusal before acceptance is only one the
// conversation itself makes: a rewind in doubt, a cleared conversation, or a journal that cannot be
// opened.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import {
  refuse,
  type AgentSessionMutationEnvelope,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../shared/tui-agent-display-names'
import type { AgentSessionFailureWordsContext } from '../../../shared/agent-session-failure-words'
import { journalOpenRefusal } from '../agent-session-journal/journal-open-failure'
import {
  structuredAgentSessionAwaitedCommand,
  type StructuredAgentSessionAwaitedCommandJournal
} from './structured-agent-session-command-turn'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import {
  AGENT_SESSION_NOT_ATTACHED,
  type AgentSessionMutationSessionPreparation
} from './structured-agent-session-mutation-admission'
import { rewindRefusal } from './structured-rewind-refusal'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'

/** Why the record refuses any send right now, whoever owns it; null when a send may run. */
export function structuredAgentSessionSendBlock(
  record: AgentSessionRecord | null
): { ok: false; refusal: AgentSessionWireRefusal } | null {
  const rewind = record?.rewind
  if (rewind?.phase === 'prepared' || rewind?.phase === 'provider-succeeded') {
    return rewindRefusal('outcome-unknown')
  }
  const command = record?.conversationCommand
  // Only a committed clear: one that never committed changed nothing, and an older build's
  // unconfirmed record is one of those.
  if (
    command?.command === 'clear' &&
    command.phase === 'committed' &&
    command.replacementSessionId
  ) {
    return {
      ok: false,
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'conversationCleared' },
        'This conversation has been cleared. Use the current conversation.'
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
    console.warn('[agent-session] opening the conversation for a write failed:', error)
    return { ok: false, refusal: journalOpenRefusal(error) }
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

/** Who a failure sentence names: the chat's agent, when the record says; and, given the journal,
 *  the command a failed start leaves to run again. */
export function structuredAgentSessionFailureWordsContext(
  record: AgentSessionRecord | null,
  journal?: StructuredAgentSessionAwaitedCommandJournal
): AgentSessionFailureWordsContext {
  const command = journal && structuredAgentSessionAwaitedCommand(journal)
  return {
    ...(record ? { agentName: TUI_AGENT_DISPLAY_NAMES[record.provider] } : {}),
    ...(command ? { command } : {})
  }
}
