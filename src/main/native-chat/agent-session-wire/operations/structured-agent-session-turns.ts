import type { JournalForkInstall } from '../../agent-session-journal/journal-fork-stages'
// Admission already passed; journal before adapter effects so a crash leaves recoverable unknown work.
// Calling the adapter first could lose a turn it accepted.

import {
  forgetNativeChatPrompt,
  rememberNativeChatPrompt
} from '../../../telemetry/native-chat-prompt-submissions'
import { captureStructuredExecutionOptions } from '../options/structured-agent-session-execution-options'
import type { AgentSessionFailureWordsContext } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionMessageSource } from '../../../../shared/agent-session/agent-session-message-source'
import {
  refuse,
  type AgentSessionWireRefusal,
  isAgentSessionRefusalError
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { AgentSessionRefusalReason } from '../../../../shared/agent-session/failures/agent-session-refusal-details'
import type { AgentSessionSendResult } from '../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionCurrentWork } from '../observations/structured-agent-session-current-work'
import type { JournalWorkReader } from '../../agent-session-journal/journal-work-read'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { JournalOperationReceipt } from '../../agent-session-journal/writing/journal-row-writer'
import type { StructuredAgentSessionAdapter } from '../providers/structured-agent-session-adapter'
import {
  classifyJournalOpenFailure,
  isJournalWrittenByNewerOrca,
  journalOpenRefusal
} from '../../agent-session-journal/replay/journal-open-failure'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import {
  isAgentSessionAttachmentExpiredError,
  type AgentSessionAttachmentExpiredError
} from '../../agent-session-attachments/agent-session-attachment-claims'
import { CommandReceiptExistsError } from '../../agent-session-journal/writing/command-receipt-transaction'
import type { StructuredAgentRegistry } from '../providers/structured-agent-registry'
import './structured-agent-session-turns-prompt'
import './structured-agent-session-turns-cancel'

export type AgentSessionTurnContext = {
  forkInstall?: JournalForkInstall
  sessionId: string
  journal: AgentSessionJournal
  fence: number
  /** Read fresh: child exit may change current work mid-operation. */
  currentWork?: () => Promise<StructuredAgentSessionCurrentWork | null>
  readWork?: JournalWorkReader
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

export function agentSessionAttachmentExpiredRefusal(error: AgentSessionAttachmentExpiredError): {
  ok: false
  refusal: AgentSessionWireRefusal
} {
  return {
    ok: false,
    refusal: refuse(
      'agent_session_operation_invalid',
      { reason: 'attachmentExpired', expiredAttachments: error.expired },
      'A chat attachment in this message is no longer stored on the host, so it was not sent.'
    )
  }
}

/** Both journal admission writes preserve refusal and receipt replay semantics before provider effects. */
export function agentSessionAdmissionWriteRefusal(
  ctx: Pick<AgentSessionTurnContext, 'sessionId' | 'logger'>,
  error: unknown
): { ok: false; refusal: AgentSessionWireRefusal } {
  if (error instanceof CommandReceiptExistsError) {
    throw error
  }
  ctx.logger.warn('recording a message failed', {
    scope: 'send-journal-write',
    sessionId: ctx.sessionId,
    error
  })
  if (isAgentSessionAttachmentExpiredError(error)) {
    return agentSessionAttachmentExpiredRefusal(error)
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
    selection?: Readonly<Record<string, string>>
  },
  userClient?: 'desktop' | 'mobile',
  telemetryOwnerKey?: string
): Promise<TurnOutcome<AgentSessionSendResult>> {
  const existing = await ctx.journal.reads.submission(input.clientMessageId)
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
  const captured = captureStructuredExecutionOptions(ctx, input.options, input.selection)
  if ('refusal' in captured) {
    return { ok: false, refusal: captured.refusal }
  }
  try {
    if (!input.body.command) {
      rememberNativeChatPrompt(
        ctx.journal,
        input.clientMessageId,
        ctx.agent,
        userClient,
        telemetryOwnerKey
      )
    }
    const submission = {
      ...input,
      options: captured.options,
      fence: ctx.fence,
      handoverRecorded: true as const
    }
    await (ctx.forkInstall
      ? ctx.journal.write({ kind: 'submission', input: submission }, () => ({
          receipt: ctx.operationReceipt,
          forkInstall: ctx.forkInstall
        }))
      : ctx.journal.appendSubmission(submission, undefined, ctx.operationReceipt))
  } catch (error) {
    forgetNativeChatPrompt(ctx.journal, input.clientMessageId)
    return agentSessionAdmissionWriteRefusal(ctx, error)
  }
  return {
    ok: true,
    value: {
      clientMessageId: input.clientMessageId,
      submission: await requireSubmission(ctx, input.clientMessageId)
    }
  }
}

async function requireSubmission(
  ctx: AgentSessionTurnContext,
  clientMessageId: string
): Promise<AgentJournalSubmission> {
  const submission = await ctx.journal.reads.submission(clientMessageId)
  if (!submission) {
    throw new Error('agent_session_submission_lost')
  }
  // Return this step’s answer; later journal settlement must not mutate it.
  return { ...submission }
}

export type AgentSessionReplayContext = Pick<
  AgentSessionTurnContext,
  'sessionId' | 'fence' | 'currentWork' | 'agent' | 'persistedOptions' | 'now'
> & {
  journal: Pick<AgentSessionJournal, 'cursor' | 'reads'> & {
    queuedMessages: Pick<AgentSessionJournal['queuedMessages'], 'get'>
  }
}
