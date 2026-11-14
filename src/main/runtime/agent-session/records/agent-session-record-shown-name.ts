import {
  agentSessionForkSourceSavedName,
  agentSessionShownName
} from '../../../../shared/agent-session/agent-session-fork-name'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'

type NamedRecord = Pick<
  AgentSessionRecord,
  'conversationName' | 'conversationNameSource' | 'forkedFrom' | 'provider'
>
type RecordReader = { getRecord: (sessionId: string) => NamedRecord | null | undefined }

/** The record's shown name, read against its source on the same host; null while unnamed. */
export function agentSessionRecordShownName(
  store: RecordReader,
  record: NamedRecord
): string | null {
  const source = record.forkedFrom ? store.getRecord(record.forkedFrom.sessionId) : null
  return agentSessionShownName(
    record,
    source ? agentSessionForkSourceSavedName(source, source.provider) : undefined
  )
}
