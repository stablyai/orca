import type {
  AgentJournalItemBody,
  AgentJournalMessageItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionRewindRecord } from '../../../shared/agent-session/lifecycle/rewind/agent-session-rewind'
import {
  encodeAgentSessionRecord,
  decodePersistedAgentSessionRecord
} from '../../../shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import {
  codexProviderHandle,
  claudeProviderHandle
} from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import {
  agentSessionOperationKey,
  pendingAgentSessionOperationRow
} from '../../../shared/agent-session/lifecycle/operations/agent-session-operation-ledger'
import { agentSessionRecordFixture } from '../testing/agent-session-record-test-fixture'
import { domainLifecycleFixture } from './journal-domain-lifecycle.test-fixture'
import { planJournalDomainRewindCut } from './journal-domain-rewind-cut'
import { JournalSqlScope } from './journal-sql-scope'
import type { JournalItemAppendOptions } from './journal-store-contracts'

export const rewindMessage = (
  text: string,
  role: 'user' | 'assistant' = 'assistant'
): AgentJournalMessageItem => ({
  kind: 'message',
  role,
  blocks: [{ type: 'text', text }]
})

export function sqlRewindFixture(cleanups: (() => void)[], provider: 'codex' | 'claude' = 'codex') {
  const sessionId = 'chat-rewind'
  const f = domainLifecycleFixture(cleanups, sessionId)
  const record = agentSessionRecordFixture({
    sessionId,
    provider,
    accountHome:
      provider === 'codex'
        ? { variable: 'CODEX_HOME', path: '/home/work/.codex' }
        : { variable: 'CLAUDE_CONFIG_DIR', path: '/home/work/.claude' },
    providerHandleChain: [
      {
        linkId: 'head',
        origin: 'adopted',
        mintedAtFence: 1,
        observedAt: 1,
        handle:
          provider === 'codex'
            ? codexProviderHandle('thread')
            : claudeProviderHandle('native', null)
      }
    ]
  })
  const writeRecord = (next: AgentSessionRecord) =>
    f.db
      .prepare(
        'INSERT INTO agent_session_records(session_id,record_json) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET record_json=excluded.record_json'
      )
      .run(sessionId, JSON.stringify(encodeAgentSessionRecord(next)))
  const readRecord = () =>
    decodePersistedAgentSessionRecord(
      JSON.parse(
        String(
          f.db
            .prepare('SELECT record_json FROM agent_session_records WHERE session_id=?')
            .get(sessionId)!.record_json
        )
      )
    ).record
  const write = (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: Partial<JournalItemAppendOptions> = {}
  ) =>
    f.run({
      kind: 'item',
      identity,
      body,
      options: { fence: 1, turnScope: { kind: 'thread' }, ...options }
    })
  const prepare = (
    itemId: string,
    overrides: Partial<AgentSessionRewindRecord> = {},
    extra: Partial<AgentSessionRecord> = {}
  ) => {
    const rewind: AgentSessionRewindRecord = {
      operationId: '1700000000000-00000000000000000000000000000001',
      callerKey: 'caller',
      itemId,
      expectedEpoch: 'epoch',
      phase: 'provider-succeeded',
      ...overrides
    }
    writeRecord({ ...record, ...extra, rewind })
    const row = pendingAgentSessionOperationRow({
      ...rewind,
      fingerprint: 'rewind',
      now: 1700000000000
    })
    f.db
      .prepare('INSERT INTO agent_session_operations(operation_key,row_json) VALUES(?,?)')
      .run(agentSessionOperationKey(rewind.callerKey, rewind.operationId), JSON.stringify(row))
    const cut =
      planJournalDomainRewindCut(new JournalSqlScope(f.db, sessionId, 'epoch'), {
        itemId,
        provider,
        nativeId: provider === 'codex' ? 'thread' : 'native'
      })?.cut ?? null
    return {
      rewind,
      complete: () =>
        f.run({ kind: 'rewind-cut', rewind, fence: 1, expectedCut: cut }, undefined, [
          {
            kind: 'store',
            mutation: { input: { kind: 'rewind-complete', sessionId, fence: 1, rewind } }
          }
        ])
    }
  }
  return { ...f, write, prepare, readRecord }
}
