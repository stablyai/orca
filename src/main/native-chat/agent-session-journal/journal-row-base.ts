import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session-journal-types'

export function journalRowBase(epoch: string, seq: number, fence: number, ts: number) {
  return { v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION, epoch, seq, fence, ts }
}
