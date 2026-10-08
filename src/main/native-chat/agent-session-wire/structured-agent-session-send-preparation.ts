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
import { isTuiAgent } from '../../../shared/tui-agent-config'
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
import { recoverStructuredRewind } from './structured-rewind-recovery'
import { structuredAgentSessionConversationFence } from './structured-agent-session-provider-child'
import { conversationCommandInFlight } from './structured-conversation-command-admission'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

function rewindInDoubt(record: AgentSessionRecord | null | undefined): boolean {
  const phase = record?.rewind?.phase
  return phase === 'prepared' || phase === 'provider-succeeded'
}

/** Why the record refuses any send right now, whoever owns it; null when a send may run. */
export function structuredAgentSessionSendBlock(
  record: AgentSessionRecord | null
): { ok: false; refusal: AgentSessionWireRefusal } | null {
  if (rewindInDoubt(record)) {
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
 *  close a stop began on that child, which it joins, so it never reaches a child that takes no
 *  input. */
export function openForProviderWrite(
  context: Pick<
    StructuredAgentSessionMutationContext,
    'openConversation' | 'joinChildClose' | 'deps'
  >,
  envelope: AgentSessionMutationEnvelope
): () => Promise<AgentSessionMutationSessionPreparation> {
  return async () => {
    const opened = await openConversationForWrite(
      context.openConversation,
      envelope,
      context.deps.logger
    )
    return opened.ok ? context.joinChildClose(envelope.sessionId) : opened
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

/** The recovery an attach runs, for a child already running: no attach comes for it. A recovery
 *  that stays unknown leaves the record as it was. */
async function recoverRewindOnLiveChild(
  context: Pick<StructuredAgentSessionMutationContext, 'deps' | 'sessions' | 'publish' | 'now'>,
  sessionId: string
): Promise<void> {
  const journal = context.sessions.get(sessionId)?.journal
  if (!journal) {
    return
  }
  try {
    await recoverStructuredRewind(
      context.deps,
      sessionId,
      journal,
      structuredAgentSessionConversationFence(context.deps.store, sessionId),
      context.deps.adapter,
      context.now
    )
  } catch (error) {
    context.deps.logger.warn('settling a rewind in doubt before a send failed', {
      scope: 'rewind-recovery',
      sessionId,
      error
    })
    return
  }
  context.publish(sessionId, journal)
}

/** A rewind still in doubt once the conversation is open is one only its provider can settle —
 *  the open settles every other — so a send settles it first: an agent at rest is started, whose
 *  attach recovers it, and a running one is asked as that attach would. One still in doubt refuses
 *  the send here, before the ledger records it, so a Retry of the same id is decided afresh. A
 *  resend of a recorded id needs only the conversation, its answer's source: it starts nothing,
 *  and an open that fails leaves that answer unknown, never refused. `clearInFlight`: a /clear was
 *  running when this send arrived, which refuses only its first run. `refusesInRun`: the caller's
 *  own run refuses a rewind in doubt with a settled answer and mints a fresh id per attempt (/clear),
 *  so preparation leaves that refusal to it. */
export function sendPreparation(
  context: Pick<
    StructuredAgentSessionMutationContext,
    'openConversation' | 'ensureAgent' | 'deps' | 'sessions' | 'publish' | 'now'
  >,
  envelope: AgentSessionMutationEnvelope,
  arrival: { clearInFlight?: boolean; refusesInRun?: boolean } = {}
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
    const { sessionId } = envelope
    if (!opened.ok || !rewindInDoubt(context.deps.store.getRecord(sessionId))) {
      return opened
    }
    const running = Boolean(context.sessions.get(sessionId)?.child)
    const ensured = await context.ensureAgent(sessionId)
    if (!ensured.ok) {
      return ensured
    }
    if (running) {
      await recoverRewindOnLiveChild(context, sessionId)
    }
    return !arrival.refusesInRun && rewindInDoubt(context.deps.store.getRecord(sessionId))
      ? rewindRefusal('outcome-unknown')
      : ensured
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
    ...(record && isTuiAgent(record.provider)
      ? { agentName: TUI_AGENT_DISPLAY_NAMES[record.provider] }
      : {}),
    ...(command ? { command } : {})
  }
}
