import { expect, it } from 'vitest'
import {
  conversationRecordReader,
  type AgentSessionRecordReader
} from '../orchestration/addressing/session-lineage/structured-session-lineage'
import {
  scaleDirectory,
  scaleRecord
} from '../agent-session/records/agent-session-scale.test-fixture'
import {
  editPersistedTestAgentSessionStore,
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../agent-session/records/agent-session-record-store-test-harness'
import { readAgentSenderSessions } from './agent-sender-chat-sessions'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
/** A committed /clear: the durable forward pointer the reverse index is derived from. */
const cleared = (
  record: AgentSessionRecord,
  next: string,
  phase: 'committed' | 'prepared' = 'committed'
): AgentSessionRecord => ({
  ...record,
  conversationCommand: {
    command: 'clear',
    runtimeFence: 8,
    operationId: `op-clear-${record.sessionId}`,
    callerKey: 'renderer',
    phase,
    state: 'completed',
    replacementSessionId: next
  }
})

it('follows branching, unreadable and cyclic /clear predecessors as the full scan does, by index', async () => {
  const root = await scaleDirectory()
  await seedTestAgentSessionRecordStore(root, {
    records: [
      cleared(scaleRecord('session-a'), 'session-c'),
      cleared(scaleRecord('session-b'), 'session-c'),
      cleared(scaleRecord('unreadable-u'), 'session-c'),
      cleared(scaleRecord('prepared-to-c'), 'session-c', 'prepared'),
      scaleRecord('session-c'),
      cleared(scaleRecord('cycle-x1'), 'cycle-y1'),
      cleared(scaleRecord('cycle-y1'), 'cycle-x1')
    ],
    sessionTabs: ['session-c', 'cycle-x1'].map((id) => ({ tabId: `tab-${id}`, sessionId: id }))
  })
  // A lease this build can't decode leaves the chat readable as a conversation.
  await editPersistedTestAgentSessionStore(root, (state) => {
    Object.assign(state.records['unreadable-u'].lease, { minimumNextFence: 'bad' })
  })
  const store = await openTestAgentSessionRecordStore(root)
  expect(store.isSessionUnreadable('unreadable-u')).toBe(true)
  const records = conversationRecordReader(store)
  const rows = (reader: AgentSessionRecordReader) =>
    readAgentSenderSessions(reader)
      .map((row) => `${row.identity.slice('orca_session_id:'.length)}>${row.sessionId}`)
      .sort()
  expect(rows(records)).toEqual([
    'cycle-x1>cycle-x1',
    'session-a>session-c',
    'session-b>session-c',
    'session-c>session-c',
    'unreadable-u>session-c'
  ])
})
