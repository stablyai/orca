import {
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  AGENT_SESSION_JOURNAL_QUEUE_SCHEMA_VERSION,
  type AgentJournalMessageItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentSessionJournalProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalRow } from './durable-rows/journal-row-schema'

const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})
const providerHandle = agentSessionJournalProviderHandle({
  agent: 'codex',
  providerHandle: codexProviderHandle('thread')
})

export function journalSqlLifecycleRows(): JournalRow[] {
  const base = { v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION, epoch: 'epoch', ts: 100, fence: 1 }
  return [
    { ...base, seq: 1, kind: 'epoch', reason: 'session_created', providerHandle },
    {
      ...base,
      v: AGENT_SESSION_JOURNAL_QUEUE_SCHEMA_VERSION,
      seq: 2,
      kind: 'queue',
      messageId: 'q',
      change: {
        op: 'queued',
        position: 1,
        queuedAt: { epoch: 'epoch', sequence: 2 },
        body: message('queued')
      }
    },
    {
      ...base,
      seq: 3,
      kind: 'submission',
      clientMessageId: 'send',
      providerHandle,
      payloadFingerprint: 'fp',
      body: message('queued'),
      queuedMessageId: 'q',
      origin: 'client',
      handoverRecorded: true
    },
    {
      ...base,
      seq: 4,
      kind: 'dispatch',
      clientMessageId: 'send',
      state: 'pending',
      providerItemId: null,
      reason: null
    },
    {
      ...base,
      seq: 5,
      kind: 'item',
      itemId: 'turn',
      revision: 0,
      body: {
        kind: 'turn',
        turnId: 't',
        state: 'running',
        userItemId: agentJournalSubmissionKey('send')
      }
    },
    {
      ...base,
      seq: 6,
      kind: 'dispatch',
      clientMessageId: 'send',
      state: 'accepted',
      providerItemId: 'provider',
      reason: null
    },
    {
      ...base,
      seq: 7,
      kind: 'item',
      itemId: 'assistant',
      revision: 0,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'stream' }] }
    },
    {
      ...base,
      seq: 8,
      kind: 'item',
      itemId: 'assistant',
      revision: 1,
      body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'streamed' }] }
    },
    {
      ...base,
      seq: 9,
      kind: 'tombstone',
      itemId: 'stop',
      revision: 0,
      stopEvent: { reason: 'user-stop', at: 100 }
    },
    {
      ...base,
      seq: 10,
      kind: 'lifecycle-batch',
      settlementId: 'settled',
      mutations: [
        {
          kind: 'item',
          itemId: 'turn',
          revision: 1,
          body: {
            kind: 'turn',
            turnId: 't',
            state: 'interrupted',
            userItemId: agentJournalSubmissionKey('send')
          }
        },
        { kind: 'tombstone', itemId: 'assistant', revision: 2 }
      ]
    },
    {
      ...base,
      seq: 11,
      kind: 'tombstone',
      itemId: 'clear',
      revision: 0,
      queueClear: { operationId: 'clear', messageIds: ['q', 'q'] }
    },
    { ...base, seq: 12, kind: 'tombstone', itemId: 'resume', revision: 0, queueResume: true },
    {
      ...base,
      seq: 13,
      kind: 'submission',
      clientMessageId: 'second',
      providerHandle,
      payloadFingerprint: 'fp',
      body: message('second'),
      handoverRecorded: true,
      origin: 'client'
    },
    {
      ...base,
      seq: 14,
      kind: 'dispatch',
      clientMessageId: 'second',
      state: 'pending',
      providerItemId: null,
      reason: null
    },
    {
      ...base,
      seq: 15,
      kind: 'item',
      itemId: 'second-turn',
      revision: 0,
      body: {
        kind: 'turn',
        turnId: 'second-turn',
        state: 'completed',
        userItemId: agentJournalSubmissionKey('second')
      }
    },
    {
      ...base,
      seq: 16,
      kind: 'item',
      itemId: 'context-clear',
      revision: 0,
      body: {
        kind: 'status',
        text: 'Cleared',
        contextClear: { operationId: 'context-clear', afterFence: 1, clearedAt: 100 }
      }
    }
  ]
}
