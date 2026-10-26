// Accept into conversations without provider ownership; delivery starts children after acceptance.

import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionWireRefusal
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
  operationDidNotRun,
  type ReadyOperationSelection
} from './structured-agent-session-operation-child'
import {
  AGENT_SESSION_NOT_ATTACHED,
  type AgentSessionMutationSessionPreparation
} from './structured-agent-session-mutation-admission'
import { agentSessionOperationOutcomeUnknown } from './structured-agent-session-replay-outcome'
import { rewindRefusal } from './structured-rewind-refusal'
import { recoverStructuredRewind } from './structured-rewind-recovery'
import {
  sameProviderChild,
  structuredAgentSessionConversationFence
} from './structured-agent-session-provider-child'
import { conversationCommandInFlight } from './structured-conversation-command-admission'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-host-mutations'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

export function rewindInDoubt(record: AgentSessionRecord | null | undefined): boolean {
  const phase = record?.rewind?.phase
  return phase === 'prepared' || phase === 'provider-succeeded'
}

export function structuredAgentSessionSendBlock(
  record: AgentSessionRecord | null
): { ok: false; refusal: AgentSessionWireRefusal } | null {
  if (rewindInDoubt(record)) {
    return rewindRefusal('outcome-unknown')
  }
  return null
}

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

export function openForWrite(
  context: Pick<StructuredAgentSessionMutationContext, 'openConversation' | 'deps'>,
  envelope: AgentSessionMutationEnvelope
): () => Promise<AgentSessionMutationSessionPreparation> {
  return () => openConversationForWrite(context.openConversation, envelope, context.deps.logger)
}

/** Join existing child close before provider writes; never start a child or reach one refusing input. */
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

/** Reconcile rewind on an already-live child; unresolved outcomes retain the existing record. */
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
      context.deps.adapter
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

/** Resolve provider-only rewind before fresh acceptance, preserving same-ID retry if refused.
 * Replay only opens for readback, never starts. clearInFlight blocks fresh runs; refusesInRun
 * leaves uncertain-rewind refusal to commands that mint a fresh ID each attempt. */
export function sendPreparation(
  context: Pick<
    StructuredAgentSessionMutationContext,
    'openConversation' | 'deps' | 'sessions' | 'publish' | 'now'
  >,
  envelope: AgentSessionMutationEnvelope,
  arrival: { clearInFlight?: boolean; refusesInRun?: boolean } = {},
  selection?: ReadyOperationSelection
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
    if (selection?.deadline !== undefined && Date.now() >= selection.deadline) {
      return operationDidNotRun(true)
    }
    const { sessionId } = envelope
    if (!opened.ok || !rewindInDoubt(context.deps.store.getRecord(sessionId))) {
      return opened
    }
    const child = context.sessions.get(sessionId)?.child
    if (
      !selection?.child ||
      !child ||
      child.phase !== 'ready' ||
      child.close ||
      !sameProviderChild(child, selection.child)
    ) {
      return rewindRefusal('outcome-unknown')
    }
    await recoverRewindOnLiveChild(context, sessionId)
    return !arrival.refusesInRun && rewindInDoubt(context.deps.store.getRecord(sessionId))
      ? rewindRefusal('outcome-unknown')
      : opened
  }
}

/** Name the recorded agent and any command a failed start leaves to retry. */
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
