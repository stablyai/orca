import { AgentSessionJournalError, JournalOutcomeDecodeError } from './journal-write-guards'
import { JournalDamageError, JournalUnreleasedSchemaError } from './journal-open-failure'
import { CommandReceiptExistsError } from './command-receipt-transaction'
import { AgentSessionAttachmentExpiredError } from '../agent-session-attachments/agent-session-attachment-claims'
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
    expired: error instanceof AgentSessionAttachmentExpiredError ? error.expired : undefined
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
  switch (error.name) {
    case 'JournalDamageError':
      return new JournalDamageError(error.message)
    case 'JournalUnreleasedSchemaError':
      return new JournalUnreleasedSchemaError(error.message)
    case 'JournalOutcomeDecodeError':
      return new JournalOutcomeDecodeError(error.message)
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
