// The effects behind send / cancel / respond / setOption.
//
// Admission (writer lease, idempotency) has already passed by the time anything
// here runs; these functions own only the journal writes and the adapter call,
// in that order. Journal first is deliberate: a crash between the two leaves a
// row the next attach settles as `unknown`, whereas the reverse would lose a
// turn the provider already accepted.

import { captureStructuredExecutionOptions } from './structured-agent-session-execution-options'
import type { AgentSessionFailureWordsContext } from '../../../shared/agent-session-failure-words'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionMessageSource } from '../../../shared/agent-session-message-source'
import {
  refuse,
  type AgentSessionRefusalReason,
  type AgentSessionSendResult,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire'
import { isAgentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { JournalOperationReceipt } from '../agent-session-journal/journal-row-writer'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  classifyJournalOpenFailure,
  isJournalWrittenByNewerOrca,
  journalOpenRefusal
} from '../agent-session-journal/journal-open-failure'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import { isAgentSessionAttachmentExpiredError } from '../agent-session-attachments/agent-session-attachment-claims'
import { CommandReceiptExistsError } from '../agent-session-journal/command-receipt-transaction'
import type { StructuredAgentRegistry } from './structured-agent-registry'
export { performPrompt } from './structured-agent-session-turns-prompt'
export { performCancel } from './structured-agent-session-turns-cancel'

export type AgentSessionTurnContext = {
  sessionId: string
  journal: AgentSessionJournal
  fence: number
  /** The host's projection of what work is current (`structuredAgentSessionCurrentWork`), read
   *  fresh per call: a child's end can move it mid-operation. */
  currentWork?: () => StructuredAgentSessionCurrentWork | null
  adapter: StructuredAgentSessionAdapter
  /** What each agent declares; the session's own answer is `agents.capabilities(agent)`. */
  agents: StructuredAgentRegistry
  /** The session's agent. */
  agent: string
  logger: StructuredAgentSessionLogger
  persistedOptions?: Readonly<Record<string, string>>
  persistOptions: (options: Readonly<Record<string, string>>) => Promise<void>
  /** Opaque client identity recorded as the resolver of a prompt. */
  resolvedBy: string
  /** Republishes state kept outside the journal, such as the record's options or rewind phase.
   *  Journal appends reach readers on their own. */
  publish: () => void
  /** Who a Stop's refusal row names. */
  failureTextContext?: AgentSessionFailureWordsContext
  /** The operation's success, committed with the row that accepts it (`settlesWithWrite` or `commandReceipt`). */
  operationReceipt?: AgentSessionOperationReceipt
  now: () => number
}

/** What accepts an operation: written with the row that accepts it, or committed alone. */
export type AgentSessionOperationReceipt = JournalOperationReceipt & {
  /** Whether it has committed, with a row or alone. */
  isCommitted: () => boolean
  /** Commits it naming no row; nothing once it has committed. */
  commitAlone: () => Promise<void>
}

export type TurnOutcome<TValue> =
  | { ok: true; value: TValue }
  | { ok: false; refusal: AgentSessionWireRefusal }

function invalid(
  reason: AgentSessionRefusalReason<'agent_session_operation_invalid'>,
  message: string
): { ok: false; refusal: AgentSessionWireRefusal } {
  return { ok: false, refusal: refuse('agent_session_operation_invalid', { reason }, message) }
}

/** A message naming an attachment this host no longer stores is refused whole, before delivery. */
export function agentSessionAttachmentExpiredRefusal(): {
  ok: false
  refusal: AgentSessionWireRefusal
} {
  return invalid(
    'attachmentExpired',
    'A chat attachment in this message is no longer stored on the host, so it was not sent.'
  )
}

/**
 * One id, one delivery. A submission that already exists replays its recorded
 * outcome and NEVER goes back on the wire, whatever state it is in and whatever
 * `retryUnknown` the client sent: `unknown` cannot prove non-delivery — that is
 * the whole content of the word — and one message reached the model five times
 * when this was a judgement call instead of an invariant. A distinct send after
 * a terminal rejection uses a fresh id, which is a first delivery.
 *
 * Accepting only records the message; the session's delivery loop hands it over.
 */
export async function performSend(
  ctx: AgentSessionTurnContext,
  input: {
    clientMessageId: string
    payloadFingerprint: string
    body: AgentJournalMessageItem
    /** Who asked for the turn; absent on callers that predate it. */
    origin?: 'client' | 'host'
    /** Who it is from; the submission keeps the kind only. */
    source?: AgentSessionMessageSource
    /** The send's `options` record, read once here into the choices the message keeps. */
    options?: Readonly<Record<string, string>>
  }
): Promise<TurnOutcome<AgentSessionSendResult>> {
  const existing = ctx.journal
    .submissions()
    .find((entry) => entry.clientMessageId === input.clientMessageId)
  if (existing && existing.payloadFingerprint !== input.payloadFingerprint) {
    return invalid(
      'messageIdReused',
      `Message id ${input.clientMessageId} was already used for another send.`
    )
  }
  if (existing) {
    return {
      ok: true,
      value: { clientMessageId: input.clientMessageId, submission: { ...existing } }
    }
  }
  const captured = captureStructuredExecutionOptions(ctx, input.options)
  if ('refusal' in captured) {
    return { ok: false, refusal: captured.refusal }
  }
  try {
    await ctx.journal.appendSubmission(
      { ...input, options: captured.options, fence: ctx.fence, handoverRecorded: true },
      undefined,
      ctx.operationReceipt
    )
  } catch (error) {
    if (error instanceof CommandReceiptExistsError) {
      throw error
    }
    ctx.logger.warn('recording a message failed', {
      scope: 'send-journal-write',
      sessionId: ctx.sessionId,
      error
    })
    if (isAgentSessionAttachmentExpiredError(error)) {
      return agentSessionAttachmentExpiredRefusal()
    }
    // Damage SQLite proves is the chat's, and no retry writes past it: say so, as an open does. So
    // does a chat holding a newer Orca's rows, which only an update writes past, and a refusal the
    // journal already classified (a failed transaction that will not roll back).
    if (
      isAgentSessionRefusalError(error) ||
      classifyJournalOpenFailure(error) === 'journalCorrupt' ||
      isJournalWrittenByNewerOrca(error)
    ) {
      return { ok: false, refusal: journalOpenRefusal(error) }
    }
    return invalid('journalWriteFailed', 'The message could not be recorded and was not sent.')
  }
  return {
    ok: true,
    value: {
      clientMessageId: input.clientMessageId,
      submission: { ...requireSubmission(ctx, input.clientMessageId) }
    }
  }
}

function requireSubmission(
  ctx: AgentSessionTurnContext,
  clientMessageId: string
): AgentJournalSubmission {
  const submission = ctx.journal
    .submissions()
    .find((entry) => entry.clientMessageId === clientMessageId)
  if (!submission) {
    throw new Error('agent_session_submission_lost')
  }
  // The answer as of this step: the journal settles its own row in place afterwards.
  return { ...submission }
}
