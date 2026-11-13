import type { LegacyProofCursor, LegacyProofPage } from './journal-legacy-source-proof'
import type {
  JournalForkPreparationInput,
  JournalForkPreparationResult
} from './journal-fork-preparation'
import type { JournalSqlFailure } from './journal-sql-failure'
import type { JournalDomainImportHeader, JournalDomainImportPage } from './journal-domain-import'
import type {
  JournalSqlDatabaseRead,
  JournalSqlDatabaseReadResult
} from './journal-sql-database-read'
import type { JournalSqlPointRead, JournalSqlPointReadResult } from './journal-sql-point-read'
import type {
  JournalDomainHistoryFrame,
  JournalDomainHistoryRequest,
  JournalDomainHistoryWork
} from './journal-domain-history-page'
import type { JournalDomainImportState } from './journal-domain-import-rows'

export type JournalSqlReaderOperation =
  | { kind: 'legacy-proof'; cursor: LegacyProofCursor }
  | { kind: 'fork-prepare'; input: JournalForkPreparationInput }
  | { kind: 'fork-next'; preparationId: number }
  | { kind: 'fork-release'; preparationId: number }
  | {
      kind: 'domain-history'
      request: JournalDomainHistoryRequest
      work?: JournalDomainHistoryWork
    }
  | { kind: 'database'; operation: JournalSqlDatabaseRead }
  | { kind: 'point'; request: JournalSqlPointRead }
  | { kind: 'conversion-prepare'; sessionId: string }
  | { kind: 'import-state'; sessionId: string }
  | { kind: 'conversion-page'; conversionId: number }
  | { kind: 'conversion-release'; conversionId: number }

export type JournalSqlReaderRequest = { id: number; operation: JournalSqlReaderOperation }
export type JournalSqlReaderReply =
  | { type: 'legacy-proof'; id: number; page: LegacyProofPage }
  | { type: 'fork-prepared'; id: number }
  | { type: 'fork-next'; id: number; result: JournalForkPreparationResult }
  | { type: 'ready' }
  | ({ type: 'page'; id: number } & JournalDomainHistoryFrame)
  | { type: 'database'; id: number; result: JournalSqlDatabaseReadResult }
  | { type: 'point'; id: number; result: JournalSqlPointReadResult }
  | { type: 'prepared'; id: number; conversion: JournalDomainImportHeader | null }
  | { type: 'import-state'; id: number; state: JournalDomainImportState }
  | { type: 'rows'; id: number; page: JournalDomainImportPage | null }
  | { type: 'released'; id: number }
  | { type: 'failed'; id?: number; error: JournalSqlFailure }

export type JournalSqlReaderResult = Exclude<JournalSqlReaderReply, { type: 'ready' | 'failed' }>
