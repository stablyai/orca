import {
  AGENT_SESSION_JOURNAL_QUEUE_SCHEMA_VERSION,
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentJournalMessageItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  agentSessionJournalProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import type { JournalRow } from './durable-rows/journal-row-schema'
import { structuredAgentSessionCommandTurn } from '../../../shared/agent-session/view/structured-agent-session-command-turn-identity'

export function journalSqlRetryRows(legacy: boolean): JournalRow[] {
  const providerHandle = agentSessionJournalProviderHandle({
    agent: 'codex',
    providerHandle: codexProviderHandle('thread')
  })
  const message = (text: string): AgentJournalMessageItem => ({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text }]
  })
  const base = {
    v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
    epoch: 'epoch',
    seq: 0,
    ts: 100,
    fence: 1
  }
  const command = { ...message('/compact'), command: { name: 'compact' as const } }
  const refused = structuredAgentSessionCommandTurn('compact')
  const result: JournalRow[] = [
    { ...base, kind: 'epoch', reason: 'session_created', providerHandle },
    ...['command', 'ordinary', 'foreign'].map((id): JournalRow => ({
      ...base,
      v: AGENT_SESSION_JOURNAL_QUEUE_SCHEMA_VERSION,
      kind: 'queue',
      messageId: id,
      change: {
        op: 'queued',
        body: id === 'command' ? command : message(id),
        position: 1,
        queuedAt: id === 'foreign' ? { epoch: 'foreign', sequence: 20 } : null
      }
    }))
  ]
  for (const attempt of ['first', 'retry']) {
    result.push(
      {
        ...base,
        v: legacy ? 3 : base.v,
        kind: 'submission',
        clientMessageId: attempt,
        providerHandle,
        body: command,
        payloadFingerprint: 'fp',
        queuedMessageId: 'command',
        handoverRecorded: true,
        origin: 'client',
        ...(legacy
          ? {}
          : {
              inputOrderContext: {
                source: { epoch: 'epoch', sequence: result.length + 1 },
                basis: 'observed',
                cut: result.length + 1
              }
            })
      },
      {
        ...base,
        kind: 'dispatch',
        clientMessageId: attempt,
        state: 'pending',
        providerItemId: null,
        reason: null,
        carries: ['carried'],
        turnScope: { kind: 'thread' }
      },
      {
        ...base,
        kind: 'item',
        itemId: refused.itemId,
        revision: attempt === 'first' ? 1 : 2,
        body: { kind: 'turn', turnId: refused.turnId, state: 'completed', outcome: 'failure' }
      },
      {
        ...base,
        kind: 'dispatch',
        clientMessageId: attempt,
        state: 'rejected',
        providerItemId: null,
        reason: 'refused',
        keptAsQueuedMessageId: 'command',
        answeredInTurn: { turnItemId: refused.itemId, via: 'start' }
      },
      {
        ...base,
        v: AGENT_SESSION_JOURNAL_QUEUE_SCHEMA_VERSION,
        kind: 'queue',
        messageId: 'command',
        change: {
          op: 'queued',
          body: command,
          position: 1,
          queuedAt: null,
          attempt,
          returned: { reason: 'refused' }
        }
      }
    )
  }
  result.push(
    {
      ...base,
      kind: 'item',
      itemId: 'failed',
      revision: 1,
      body: { kind: 'turn', turnId: 'failed', state: 'completed', outcome: 'failure' }
    },
    {
      ...base,
      kind: 'tombstone',
      itemId: 'reopen',
      revision: 1,
      queueReopen: true,
      queueReopenSince: 2
    },
    { ...base, kind: 'tombstone', itemId: 'resume', revision: 1, queueResume: true },
    {
      ...base,
      kind: 'submission',
      clientMessageId: 'send',
      providerHandle,
      body: message('ordinary'),
      payloadFingerprint: 'fp',
      queuedMessageId: 'ordinary',
      origin: 'host'
    },
    {
      ...base,
      kind: 'dispatch',
      clientMessageId: 'send',
      state: 'accepted',
      providerItemId: agentJournalItemKey({
        provider: 'codex',
        threadId: 'thread',
        turnId: 'echo',
        ordinal: 0
      }),
      reason: null
    },
    {
      ...base,
      kind: 'item',
      itemId: agentJournalItemKey({
        provider: 'codex',
        threadId: 'thread',
        turnId: 'echo',
        ordinal: 0
      }),
      revision: 1,
      body: message('ordinary')
    },
    { ...base, kind: 'tombstone', itemId: 'failed', revision: 2 },
    {
      ...base,
      v: AGENT_SESSION_JOURNAL_QUEUE_SCHEMA_VERSION,
      kind: 'queue',
      messageId: 'foreign',
      change: { op: 'moved', position: -1 }
    },
    {
      ...base,
      v: AGENT_SESSION_JOURNAL_QUEUE_SCHEMA_VERSION,
      kind: 'queue',
      messageId: 'foreign',
      change: { op: 'withdrawn' }
    }
  )
  return result.map((row, i) => ({ ...row, seq: i + 1 }))
}
