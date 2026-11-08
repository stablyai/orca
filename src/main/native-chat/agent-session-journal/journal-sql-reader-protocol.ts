import type { AgentSessionHistoryResult } from '../../../shared/agent-session/agent-session-wire'
import type { JournalSqlHistoryRequest } from './journal-sql-history-page'
import type { JournalSqlFailure } from './journal-sql-failure'
import type { JournalDomainImportHeader, JournalDomainImportPage } from './journal-domain-import'
import type {
  JournalSqlDatabaseRead,
  JournalSqlDatabaseReadResult
} from './journal-sql-database-read'
import type { JournalSqlPointRead, JournalSqlPointReadResult } from './journal-sql-point-read'
import type { JournalDomainHistoryRequest } from './journal-domain-history-page'
import type { JournalDomainImportState } from './journal-domain-import-rows'

export type JournalSqlReaderOperation =
  | { kind: 'history'; request: JournalSqlHistoryRequest }
  | { kind: 'domain-history'; request: JournalDomainHistoryRequest }
  | { kind: 'database'; operation: JournalSqlDatabaseRead }
  | { kind: 'point'; request: JournalSqlPointRead }
  | { kind: 'conversion-prepare'; sessionId: string }
  | { kind: 'import-state'; sessionId: string }
  | { kind: 'conversion-page'; conversionId: number }
  | { kind: 'conversion-release'; conversionId: number }

export type JournalSqlReaderRequest = { id: number; operation: JournalSqlReaderOperation }
export type JournalSqlReaderReply =
  | { type: 'ready' }
  | { type: 'page'; id: number; result: AgentSessionHistoryResult }
  | { type: 'database'; id: number; result: JournalSqlDatabaseReadResult }
  | { type: 'point'; id: number; result: JournalSqlPointReadResult }
  | { type: 'prepared'; id: number; conversion: JournalDomainImportHeader | null }
  | { type: 'import-state'; id: number; state: JournalDomainImportState }
  | { type: 'rows'; id: number; page: JournalDomainImportPage | null }
  | { type: 'released'; id: number }
  | { type: 'failed'; id?: number; error: JournalSqlFailure }

export type JournalSqlReaderResult = Exclude<JournalSqlReaderReply, { type: 'ready' | 'failed' }>
