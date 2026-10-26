// Admission already passed; journal before adapter effects so a crash leaves recoverable unknown work.
// Calling the adapter first could lose a turn it accepted.

import { captureStructuredExecutionOptions } from './structured-agent-session-execution-options'
import type { AgentSessionFailureWordsContext } from '../../../shared/agent-session-failure-words'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { AgentSessionMessageSource } from '../../../shared/agent-session/agent-session-message-source'
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
  /** Read fresh: child exit may change current work mid-operation. */
  currentWork?: () => StructuredAgentSessionCurrentWork | null
  adapter: StructuredAgentSessionAdapter
  /** Registry declarations; agents.capabilities(agent) is this session’s answer. */
  agents: StructuredAgentRegistry
  agent: string
  logger: StructuredAgentSessionLogger
  persistedOptions?: Readonly<Record<string, string>>
  persistOptions: (options: Readonly<Record<string, string>>) => Promise<void>
  resolvedBy: string
  /** Publish non-journal state; appends publish themselves. */
  publish: () => void
  failureTextContext?: AgentSessionFailureWordsContext
  /** Commit success alongside its accepting write or standalone receipt. */
  operationReceipt?: AgentSessionOperationReceipt
  now: () => number
}

export type AgentSessionOperationReceipt = JournalOperationReceipt & {
  isCommitted: () => boolean
  /** No-op once committed. */
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

export function agentSessionAttachmentExpiredRefusal(): {
  ok: false
  refusal: AgentSessionWireRefusal
} {
  return invalid(
    'attachmentExpired',
    'A chat attachment in this message is no longer stored on the host, so it was not sent.'
  )
}

/** Accept once per ID; existing submissions replay without redelivery because unknown cannot prove non-delivery.
 * Delivery runs separately; a fresh send after terminal rejection needs a fresh ID. */
export async function performSend(
  ctx: AgentSessionTurnContext,
  input: {
    clientMessageId: string
    payloadFingerprint: string
    body: AgentJournalMessageItem
    /** Absent on older callers. */
    origin?: 'client' | 'host'
    /** Persist only source kind in the submission. */
    source?: AgentSessionMessageSource
    options?: Readonly<Record<string, string>>
    keepCurrentOptions?: true
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
  const { keepCurrentOptions, ...submission } = input
  const captured = keepCurrentOptions
    ? { options: undefined }
    : captureStructuredExecutionOptions(ctx, input.options)
  if ('refusal' in captured) {
    return { ok: false, refusal: captured.refusal }
  }
  try {
    await ctx.journal.appendSubmission(
      { ...submission, options: captured.options, fence: ctx.fence, handoverRecorded: true },
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
    // Preserve typed refusals, corrupt-database errors and newer-version guards; never retry writes past them.
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
  // Return this step’s answer; later journal settlement must not mutate it.
  return { ...submission }
}
