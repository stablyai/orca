import type Database from '../../sqlite/sync-database'
import {
  isPersistedAgentSessionRecord,
  agentSessionExecutionLocationsEqual,
  type AgentSessionExecutionLocation
} from '../../../shared/agent-session/lifecycle/agent-session-record'
import { decodePersistedAgentSessionRecord } from '../../../shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import { activeProviderContext } from '../../../shared/agent-session/agent-session-provider-context'
import { agentConversationCopyRefusal } from '../conversation-adoption/agent-conversation-copy-error'
import { structuredAgentSessionForkBoundary } from '../agent-session-wire/acquisition/structured-agent-session-fork-boundary'
import { readJournalDomainForkBoundary } from './journal-domain-fork-reads'
import { JournalSqlScope } from './journal-sql-scope'

export type JournalForkSourceProof = {
  sessionId: string
  throughItemId: string
  capability: 'checkpoint' | 'tip'
  retained: string
  location: AgentSessionExecutionLocation
  submissionsToken: string | null
}

/** Both freeze and installation compare the same semantic boundary against their current source. */
export function validateJournalForkSource(db: Database.Database, proof: JournalForkSourceProof) {
  const fail = (): never => {
    throw agentConversationCopyRefusal(
      'agent_session_operation_invalid',
      { reason: 'savedConversationMissing' },
      'The source context changed while copying this chat. Try again.'
    )
  }
  const saved = db
    .prepare('SELECT record_json FROM agent_session_records WHERE session_id=?')
    .get(proof.sessionId)
  const value: unknown = saved ? JSON.parse(String(saved.record_json)) : undefined
  if (!isPersistedAgentSessionRecord(value) || value.sessionId !== proof.sessionId) {
    return fail()
  }
  const record = decodePersistedAgentSessionRecord(value).record
  const context = activeProviderContext(record)
  if (
    !context.head ||
    context.pendingClear ||
    record.rewind?.phase === 'prepared' ||
    record.rewind?.phase === 'provider-succeeded' ||
    (record.conversationCommand?.command === 'clear' &&
      (record.conversationCommand.phase === 'prepared' ||
        record.conversationCommand.state === 'unknown')) ||
    !agentSessionExecutionLocationsEqual(record.location, proof.location)
  ) {
    return fail()
  }
  const head = db
    .prepare('SELECT epoch FROM journal_chat_state WHERE session_id=? AND epoch IS NOT NULL')
    .get(proof.sessionId)
  if (!head) {
    return fail()
  }
  const epoch = String(head.epoch)
  const read = readJournalDomainForkBoundary(
    new JournalSqlScope(db, proof.sessionId, epoch),
    proof.throughItemId,
    undefined,
    proof.capability === 'tip'
  )
  const boundary = structuredAgentSessionForkBoundary(
    read.snapshot,
    record,
    proof.throughItemId,
    proof.capability
  )
  if (
    !boundary ||
    boundary.retained !== proof.retained ||
    (proof.capability === 'tip' &&
      (!boundary.latest || read.submissionsToken !== proof.submissionsToken))
  ) {
    return fail()
  }
  return { epoch, boundary, record }
}
