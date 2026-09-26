// The sentence the host persists beside each failure fact, and the facts a start or an exit
// reduces to.
//
// A row's `text` and a rejected message's `reason` are what every released client prints as they
// are, so they are written here for a person and never carry Orca's own error text: not a
// refusal's message, not an exception, not a probe's evidence. A provider's words reach the text
// only when the provider wrote them for a person; a log's never do. Newer clients choose their
// own copy from the fact.

import {
  agentSessionFailureFact,
  providerDiagnosticOf,
  type AgentSessionFailureFact,
  type AgentSessionFailureKind,
  type ProviderDiagnostic
} from '../../../shared/agent-session-failure'
import {
  agentSessionRefusalReference,
  type AgentSessionWireRefusal,
  type AgentSessionWireRefusalCode
} from '../../../shared/agent-session-wire-refusals'
import {
  DISPATCH_REJECTION_NOT_DELIVERED,
  type AgentJournalDispatchRejection
} from '../../../shared/structured-agent-session-dispatch-rejection'
import { AgentSessionAcquisitionRefusal } from './structured-agent-session-adapter'

/** Person-facing provider text is quoted, but bounded so the sentence stays one. */
const MAX_QUOTED_DETAIL_CHARS = 512

/**
 * Whether a refused start leaves the chat anything to start again from. `false`: this host has
 * nothing to restart it from — no record, or none it can run — so only a new chat continues.
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

export type AgentSessionFailureTextContext = {
  /** The chat's agent, when the writer knows it. */
  agentName?: string
}

type Sentence = (context: AgentSessionFailureTextContext, fact: AgentSessionFailureFact) => string

function quotingPersonDetail(lead: string, detail: ProviderDiagnostic | undefined): string {
  const quoted =
    detail?.audience === 'person'
      ? detail.text
          .slice(0, MAX_QUOTED_DETAIL_CHARS)
          .trim()
          .replace(/[.\s]+$/, '')
      : ''
  return quoted ? `${lead}: ${quoted}.` : `${lead}.`
}

const FAILURE_SENTENCES = {
  providerStartFailed: () => 'The provider stopped before it finished starting.',
  notSignedIn: ({ agentName }) =>
    `${agentName ?? 'The agent'} is not signed in for the selected account. Sign in, then send your message again.`,
  historyTooLarge: () =>
    "This conversation's history is too large to restore here. Start a new chat to continue.",
  providerExited: () => 'The provider stopped before this message was sent.',
  restartFailed: ({ agentName }, fact) => {
    const failed = `${agentName ?? 'The agent'} couldn't restart.`
    const code = fact.refusal?.code
    return code && !START_REFUSAL_RESUMABLE[code]
      ? `${failed} Start a new chat to continue.`
      : failed
  },
  providerRejected: (_, fact) =>
    quotingPersonDetail('The provider did not accept this message', fact.detail),
  attachmentInvalid: () => "An attachment on this message can't be sent to the agent.",
  attachmentUnreadable: () =>
    "An attachment on this message couldn't be read, so the message was not sent.",
  queueFull: () => 'Too many messages were waiting for the agent, so this one was not sent.',
  writeFailed: () => "Orca couldn't hand this message to the agent, so it was not sent.",
  cancelled: () => 'This message was withdrawn before the agent started it.',
  chatClosed: () => 'The chat closed before this message was sent.',
  hostRestarted: () => 'Orca restarted before this message was sent.',
  notDelivered: () => DISPATCH_REJECTION_NOT_DELIVERED.reason,
  compactionFailed: (_, fact) => quotingPersonDetail('Compaction failed', fact.detail),
  compactionUnconfirmed: () => 'Compaction completion is unconfirmed.',
  cancelUnconfirmed: () => 'Cancellation was not confirmed.',
  answerUnconfirmed: () => 'Your answer was recorded but the agent did not confirm it.',
  hostFault: () => "Orca ran into a problem, so this didn't go through. Try again."
} satisfies Record<AgentSessionFailureKind, Sentence>

/** The sentence a row or a rejected message records for this fact. */
export function agentSessionFailureText(
  fact: AgentSessionFailureFact,
  context: AgentSessionFailureTextContext = {}
): string {
  const sentence: Sentence = FAILURE_SENTENCES[fact.kind]
  return sentence(context, fact)
}

/** A rejection whose reason is the fact's sentence. The legacy markers are written by their own
 *  constants, never through here. */
export function agentSessionFailureRejection(
  fact: AgentSessionFailureFact,
  context: AgentSessionFailureTextContext = {}
): AgentJournalDispatchRejection {
  return { reason: agentSessionFailureText(fact, context), rejection: fact }
}

/** A start that did not land. A refusal the adapter typed keeps its situation; anything else is a
 *  start that failed, with the provider's diagnostic when the error carried one. */
export function providerStartupFailureFact(cause?: unknown): AgentSessionFailureFact {
  if (
    cause instanceof AgentSessionAcquisitionRefusal &&
    (cause.refusalCause === 'notSignedIn' || cause.refusalCause === 'historyTooLarge')
  ) {
    return agentSessionFailureFact(cause.refusalCause)
  }
  return agentSessionFailureFact('providerStartFailed', { detail: providerDiagnosticOf(cause) })
}

/** A child that ended before it proved its start: an exit is a start that failed, keeping the
 *  provider's diagnostic; an Orca fault or a typed start refusal stays what it was. */
export function startupFailureFromExit(
  failure: AgentSessionFailureFact | undefined
): AgentSessionFailureFact {
  if (!failure || failure.kind === 'providerExited') {
    return agentSessionFailureFact('providerStartFailed', { detail: failure?.detail })
  }
  return failure
}

/** What the chat records when the delivery loop could not make the session ready. */
export function restartFailureFact(refusal: AgentSessionWireRefusal): AgentSessionFailureFact {
  if (refusal.cause === 'notSignedIn' || refusal.cause === 'historyTooLarge') {
    return agentSessionFailureFact(refusal.cause)
  }
  // A child that died starting reads as any start that died does.
  if (refusal.ownerVerdict === 'exited' || refusal.cause === 'providerStartFailed') {
    return agentSessionFailureFact('providerStartFailed')
  }
  return agentSessionFailureFact('restartFailed', {
    refusal: agentSessionRefusalReference(refusal)
  })
}
