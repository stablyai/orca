import { AgentSessionJournalError, JournalOutcomeDecodeError } from './writing/journal-write-guards'
import { JournalDamageError, JournalUnreleasedSchemaError } from './replay/journal-open-failure'
import { CommandReceiptExistsError } from './writing/command-receipt-transaction'
import { JournalProjectionStaleError } from './journal-sql-meta'
import { AgentSessionAttachmentExpiredError } from '../agent-session-attachments/agent-session-attachment-claims'
import {
  JournalHostFactsNeededError,
  type JournalHostFactsNeeded
} from './journal-writer-host-facts'
import {
  QueuedMessageNotConsumableError,
  QueuedMessageNotOwedError
} from './queued-messages/queued-message-consume-error'
import {
  AgentSessionRefusalError,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session/failures/agent-session-wire-refusals'

export type JournalSqlFailure = {
  name: string
  message: string
  code?: string
  errcode?: number
  receipt?: CommandReceiptExistsError['result']
  refusal?: AgentSessionWireRefusal
  expired?: AgentSessionAttachmentExpiredError['expired']
  needs?: JournalHostFactsNeeded
  /** Queue refusals keep their identity for the host's retry and refusal paths. */
  queued?: { messageId: string; expected?: 'waiting' | 'returned'; owed?: 'stale' | 'unavailable' }
}

export function journalSqlFailure(error: unknown): JournalSqlFailure {
  return {
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    code:
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : undefined,
    errcode:
      error instanceof Error && 'errcode' in error && typeof error.errcode === 'number'
        ? error.errcode
        : undefined,
    receipt: error instanceof CommandReceiptExistsError ? error.result : undefined,
    refusal: error instanceof AgentSessionRefusalError ? error.refusal : undefined,
    expired: error instanceof AgentSessionAttachmentExpiredError ? error.expired : undefined,
    needs: error instanceof JournalHostFactsNeededError ? error.needs : undefined,
    queued:
      error instanceof QueuedMessageNotConsumableError
        ? { messageId: error.messageId, expected: error.expected }
        : error instanceof QueuedMessageNotOwedError
          ? { messageId: error.messageId, owed: error.owed }
          : undefined
  }
}

/** Error identity is part of the host's existing retry/refusal contract. */
export function restoreJournalSqlFailure(error: JournalSqlFailure): Error {
  if (error.expired) {
    return new AgentSessionAttachmentExpiredError(error.expired)
  }
  if (error.receipt) {
    return new CommandReceiptExistsError(error.receipt)
  }
  if (error.refusal) {
    return new AgentSessionRefusalError(error.refusal)
  }
  if (error.needs) {
    return new JournalHostFactsNeededError(error.needs)
  }
  if (error.queued?.expected) {
    return new QueuedMessageNotConsumableError(error.queued.messageId, error.queued.expected)
  }
  if (error.queued?.owed) {
    return new QueuedMessageNotOwedError(error.queued.messageId, error.queued.owed)
  }
  switch (error.name) {
    case 'JournalDamageError':
      return new JournalDamageError(error.message)
    case 'JournalUnreleasedSchemaError':
      return new JournalUnreleasedSchemaError(error.message)
    case 'JournalOutcomeDecodeError':
      return new JournalOutcomeDecodeError(error.message)
    case 'JournalProjectionStaleError':
      return new JournalProjectionStaleError(error.message)
    case 'AgentSessionJournalError': {
      const code = error.code
      if (
        code === 'journal_read_only' ||
        code === 'journal_stale_fence' ||
        code === 'journal_closed' ||
        code === 'journal_submission_exists' ||
        code === 'journal_row_rejected'
      ) {
        return new AgentSessionJournalError(code, error.message)
      }
    }
  }
  return Object.assign(new Error(error.message), error)
}

export type JournalWriterSettled<T = unknown> = { value: T } | { failure: JournalSqlFailure }
