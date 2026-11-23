import type {
  AgentJournalItemBody,
  AgentJournalMessageItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionRewindRecord } from '../../../shared/agent-session/lifecycle/rewind/agent-session-rewind'
import { encodeAgentSessionRecord } from '../../../shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import {
  agentSessionOperationKey,
  pendingAgentSessionOperationRow
} from '../../../shared/agent-session/lifecycle/operations/agent-session-operation-ledger'
import { agentSessionRecordFixture } from '../testing/agent-session-record-test-fixture'
import { JOURNAL_ENDED_TURN_COUNTS_SCHEMA } from './database/journal-ended-turn-counts'
import { messageFixture } from './journal-sql-message.test-fixture'
import { planJournalDomainRewindCut } from './journal-domain-rewind-cut'
import { JournalSqlScope } from './journal-sql-scope'
import type { JournalItemAppendOptions } from './journal-store-contracts'
import type { JournalWriterCommand, JournalWriterOperation } from './journal-writer-command'
import type { JournalWriterHostFacts } from './journal-writer-host-facts'

export const rewindMessage = (
  text: string,
  role: 'user' | 'assistant' = 'assistant'
): AgentJournalMessageItem => ({ kind: 'message', role, blocks: [{ type: 'text', text }] })

export function sqlRewindFixture(cleanups: (() => void)[]) {
  const f = messageFixture()
  cleanups.push(() => f.db.close())
  f.db.exec(JOURNAL_ENDED_TURN_COUNTS_SCHEMA)
  const sessionId = 'chat-rewind'
  const target = { sessionId, epoch: 'epoch', ownerToken: 'owner' }
  const handle = {
    transport: 'traex-app-server' as const,
    agent: 'trae' as const,
    nativeId: 'thread'
  }
  const facts: JournalWriterHostFacts = {
    identity: {
      sessionId,
      workspaceId: 'workspace',
      hostId: 'host',
      agent: 'trae',
      providerHandle: handle
    }
  }
  f.db
    .prepare(
      "INSERT INTO journal_chat_state(session_id,workspace_id,epoch,highest_fence) VALUES(?,'workspace','epoch',1)"
    )
    .run(sessionId)
  const record = agentSessionRecordFixture({
    sessionId,
    provider: 'trae',
    accountHome: { variable: 'TRAECLI_HOME', path: '/home/work/.trae/cli' },
    providerHandleChain: [
      { linkId: 'head', origin: 'adopted', mintedAtFence: 1, observedAt: 1, handle }
    ]
  })
  const run = async (
    operation: JournalWriterOperation,
    effects?: JournalWriterCommand['effects']
  ) => {
    const result = await f.commitCommands([
      { target, operation, facts, ...(effects ? { effects } : {}) }
    ])
    const answer = result.outcomes[0]!
    if (!answer.committed) {
      throw answer.error
    }
    return answer.value
  }
  const write = (
    identity: AgentJournalItemIdentity,
    body: AgentJournalItemBody,
    options: Partial<JournalItemAppendOptions> = {}
  ) =>
    run({
      kind: 'item',
      identity,
      body,
      options: { fence: 1, turnScope: { kind: 'thread' }, ...options }
    })
  const prepare = (itemId: string) => {
    const rewind: AgentSessionRewindRecord = {
      operationId: '1700000000000-00000000000000000000000000000001',
      callerKey: 'caller',
      itemId,
      expectedEpoch: 'epoch',
      phase: 'provider-succeeded'
    }
    f.db
      .prepare('INSERT INTO agent_session_records(session_id,record_json) VALUES(?,?)')
      .run(sessionId, JSON.stringify(encodeAgentSessionRecord({ ...record, rewind })))
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
        provider: 'trae',
        nativeId: 'thread'
      })?.cut ?? null
    return {
      complete: () =>
        run({ kind: 'rewind-cut', rewind, fence: 1, expectedCut: cut }, [
          {
            kind: 'store',
            mutation: { input: { kind: 'rewind-complete', sessionId, fence: 1, rewind } }
          }
        ])
    }
  }
  return { db: f.db, item: f.item, write, prepare, run }
}
