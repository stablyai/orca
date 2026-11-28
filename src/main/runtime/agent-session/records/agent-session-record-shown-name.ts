import {
  agentSessionForkSourceSavedName,
  agentSessionShownName
} from '../../../../shared/agent-session/conversation-naming/agent-session-fork-name'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'

type NamedRecord = Pick<
  AgentSessionRecord,
  'sessionId' | 'conversationName' | 'conversationNameSource' | 'forkedFrom' | 'provider'
>
type RecordReader = { getRecord: (sessionId: string) => NamedRecord | null | undefined }

/** The record's shown name, read against its source on the same host; null while unnamed. The record
 *  is read again through the store, so a raw one (a writable record) is titled as every reader sees it. */
export function agentSessionRecordShownName(
  store: RecordReader,
  stored: NamedRecord
): string | null {
  const record = store.getRecord(stored.sessionId) ?? stored
  const source = record.forkedFrom ? store.getRecord(record.forkedFrom.sessionId) : null
  return agentSessionShownName(
    record,
    source ? agentSessionForkSourceSavedName(source, source.provider) : undefined
  )
}
