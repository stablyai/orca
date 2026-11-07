import type { AgentSessionHistoryResult } from '../../../shared/agent-session/agent-session-wire'
import type { JournalSqlHistoryRequest } from './journal-sql-history-page'
import type { JournalSqlFailure } from './journal-sql-failure'
import type { JournalSqlConversion, JournalSqlConversionTable } from './journal-sql-conversion'

export type JournalSqlConversionHeader = Omit<JournalSqlConversion, 'tables'>

export type JournalSqlReaderOperation =
  | { kind: 'history'; request: JournalSqlHistoryRequest }
  | { kind: 'conversion-prepare'; sessionId: string }
  | { kind: 'conversion-page'; conversionId: number }
  | { kind: 'conversion-release'; conversionId: number }

export type JournalSqlReaderRequest = { id: number; operation: JournalSqlReaderOperation }
export type JournalSqlReaderReply =
  | { type: 'ready' }
  | { type: 'page'; id: number; result: AgentSessionHistoryResult }
  | { type: 'prepared'; id: number; conversion: JournalSqlConversionHeader | null }
  | { type: 'rows'; id: number; page: JournalSqlConversionTable | null }
  | { type: 'released'; id: number }
  | { type: 'failed'; id?: number; error: JournalSqlFailure }

export type JournalSqlReaderResult = Exclude<JournalSqlReaderReply, { type: 'ready' | 'failed' }>
