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
import { agentSessionOperationOutcomeUnknown } from './structured-agent-session-replay-outcome'
import { rewindRefusal } from './structured-rewind-refusal'
import { conversationCommandInFlight } from './structured-conversation-command-admission'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

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

/** The conversation a send or a Stop writes to, opened when this host holds it closed. Once it
 *  answers, every write issued before it has settled, so a mutation reads a whole fold. */
export async function openConversationForWrite(
  openConversation: (sessionId: string) => Promise<StructuredAgentSessionHostSession | null>,
  envelope: AgentSessionMutationEnvelope,
  logger: StructuredAgentSessionLogger
): Promise<AgentSessionMutationSessionPreparation> {
  let session: StructuredAgentSessionHostSession | null
  try {
    session = await openConversation(envelope.sessionId)
  } catch (error) {
    logger.warn('opening the conversation for a write failed', {
      scope: 'open-for-write',
      sessionId: envelope.sessionId,
      error
    })
    return { ok: false, refusal: journalOpenRefusal(error) }
  }
  if (!session) {
    return { ok: false, refusal: AGENT_SESSION_NOT_ATTACHED }
  }
  // Writes wait behind a restore's owed import. A failed import settled them too (they failed
  // with it), so it is reported and never refuses the mutation: its own writes fail as they would.
  if (session.journal.importPending) {
    await session.journal.whenImported().catch((error: unknown) => {
      logger.warn('the import owed before a write failed', {
        scope: 'open-for-write',
        sessionId: envelope.sessionId,
        error
      })
    })
  }
  return { ok: true }
}

/** The conversation a write lands in, opened when this host holds it closed. */
export function openForWrite(
  context: Pick<StructuredAgentSessionMutationContext, 'openConversation' | 'deps'>,
  envelope: AgentSessionMutationEnvelope
): () => Promise<AgentSessionMutationSessionPreparation> {
  return () => openConversationForWrite(context.openConversation, envelope, context.deps.logger)
}

/** For an operation the running child performs, which starts none: the conversation, then any
 *  stop an earlier attempt left owed, so it never reaches a child that takes no input. */
export function openForProviderWrite(
  context: Pick<
    StructuredAgentSessionMutationContext,
    'openConversation' | 'finishOwedStop' | 'deps'
  >,
  envelope: AgentSessionMutationEnvelope
): () => Promise<AgentSessionMutationSessionPreparation> {
  return async () => {
    const opened = await openConversationForWrite(
      context.openConversation,
      envelope,
      context.deps.logger
    )
    return opened.ok ? context.finishOwedStop(envelope.sessionId) : opened
  }
}

/** For an operation only the provider can perform: the conversation, then its agent. */
export function openWithAgent(
  context: Pick<StructuredAgentSessionMutationContext, 'openConversation' | 'ensureAgent' | 'deps'>,
  envelope: AgentSessionMutationEnvelope
): () => Promise<AgentSessionMutationSessionPreparation> {
  return async () => {
    const opened = await openConversationForWrite(
      context.openConversation,
      envelope,
      context.deps.logger
    )
    return opened.ok ? context.ensureAgent(envelope.sessionId) : opened
  }
}

/** A rewind still in doubt once the conversation is open is one only its provider can settle —
 *  the open settles every other — so a send starts the agent, whose attach recovers it. A resend
 *  of a recorded id needs only the conversation, its answer's source: it starts nothing, and an
 *  open that fails leaves that answer unknown, never refused. `clearInFlight`: a /clear was running
 *  when this send arrived, which refuses only its first run. */
export function sendPreparation(
  context: Pick<StructuredAgentSessionMutationContext, 'openConversation' | 'ensureAgent' | 'deps'>,
  envelope: AgentSessionMutationEnvelope,
  arrival: { clearInFlight?: boolean } = {}
): (ledger: 'admit' | 'replay') => Promise<AgentSessionMutationSessionPreparation> {
  return async (ledger) => {
    if (ledger === 'admit' && arrival.clearInFlight) {
      return { ok: false, refusal: conversationCommandInFlight() }
    }
    const opened = await openConversationForWrite(
      context.openConversation,
      envelope,
      context.deps.logger
    )
    if (ledger === 'replay') {
      return opened.ok
        ? opened
        : { ok: false, refusal: agentSessionOperationOutcomeUnknown(envelope.clientOperationId) }
    }
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
