import type { AgentSessionReserveRequest } from '../../runtime/agent-session/ownership/agent-session-reservation-admission'
import type { ProtectedUpload } from './protected-journal-uploads'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalSqlDatabase } from './database/journal-sql-database'
import type { JournalSqlReaderPool } from './journal-sql-reader-pool'
import type { JournalWriterCommand, JournalOpenRecovery } from './journal-writer-command'

export type SessionDatabase = Pick<
  JournalSqlDatabase,
  'openSession' | 'serialize' | 'sessionEpoch' | 'rememberSessionEpoch' | 'requestSweep' | 'sending'
> & {
  readers: Pick<JournalSqlReaderPool, 'point' | 'domainHistoryFrame'>
}

export type ProtectedJournalCall =
  | { op: 'found'; sessionId: string; workspaceId: string; provider: string; operationId: string }
  | { op: 'placement'; request: Omit<AgentSessionReserveRequest, 'spawnToken' | 'launchEnv'> }
  | { op: 'upload'; upload: ProtectedUpload }
  | { op: 'open'; identity: AgentSessionJournalIdentity; recover?: JournalOpenRecovery }
  | { op: 'write'; command: JournalWriterCommand }
  | { op: 'point'; request: Parameters<JournalSqlReaderPool['point']>[0] }
  | {
      op: 'history'
      request: Parameters<JournalSqlReaderPool['domainHistoryFrame']>[0]
      work?: Parameters<JournalSqlReaderPool['domainHistoryFrame']>[1]
    }
  | { op: 'epoch'; sessionId: string }

export type ProtectedJournalPolicy = {
  version: 1
  producerUid: number
  botId: string
  workspaceId: string
  writerEpoch: string
  socketPath: string
}
