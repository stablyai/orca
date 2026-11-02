import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, it } from 'vitest'
import type { AgentSessionProviderHandleLink } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { agentSessionProviderHandleKey } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { encodeAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record-stored-form'
import { selectRecoveryDelivery } from '../agent-session-context-transfer-text'
import { agentSessionRecordFixture } from '../agent-session-record-test-fixture'
import { writeContextTransferJournalReceipts } from './context-transfer-journal-receipts'
import type { ContextTransferRecord } from './context-transfer-record'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase
} from './journal-host-database-test-support'
import { createJournalReducerState } from './journal-reducer'
import { ContextTransferFacts } from './context-transfer-facts'
import {
  expectSameKeyedWork,
  instrumentContextTransferFacts
} from './context-transfer-scaling.test-support'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session/journal/agent-session-journal-types'

const SESSION = 'chat-retained-carriers'
const roots: string[] = []
afterEach(async () => {
  await closeTestJournalHostDatabases()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const nativeId = (i: number) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`
const link = (i: number): AgentSessionProviderHandleLink => ({
  linkId: `L${i}`,
  handle: { transport: 'codex-app-server', agent: 'codex', nativeId: nativeId(i) },
  origin: 'created',
  mintedAtFence: i + 1,
  observedAt: i + 1,
  ...(i
    ? {
        replaces: {
          key: agentSessionProviderHandleKey({
            transport: 'codex-app-server',
            agent: 'codex',
            nativeId: nativeId(i - 1)
          }),
          reason: 'restore-failed',
          replacedAt: i + 1
        }
      }
    : {})
})

/** Counts decoded rows and transfer queries while one unrelated accepted dispatch passes N retained carriers. */
async function unrelatedBatchWork(retained: number) {
  const root = await mkdtemp(join(tmpdir(), 'orca-transfer-receipts-'))
  roots.push(root)
  const { db } = openTestJournalHostDatabase(root)
  const chain = [link(0)]
  const capture = {
    selectionVersion: 1 as const,
    messages: [
      {
        itemId: 'saved',
        revision: 1,
        sequence: 1,
        sequenceIndex: 0,
        role: 'assistant' as const,
        kind: 'message' as const,
        text: 'Remember 42'
      }
    ],
    coverage: {
      eligibleCount: 1,
      omittedCount: 0,
      firstItemId: 'saved',
      lastItemId: 'saved',
      inventoryDigest: 'digest'
    }
  }
  const selection = selectRecoveryDelivery({
    id: 'D',
    capture,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Next request' }] }
  })
  const records: ContextTransferRecord[] = [
    {
      kind: 'handoff',
      id: 'H',
      handoffId: 'H',
      sessionId: SESSION,
      sourceLink: chain[0],
      sourceCursor: { epoch: 'e', sequence: 2 },
      contextFloor: null,
      trigger: 'codex-no-rollout',
      capturedAt: 2,
      capture
    }
  ]
  for (let i = 1; i <= retained; i++) {
    const targetLink = link(i)
    chain.push(targetLink)
    const target: ContextTransferRecord = {
      kind: 'target',
      id: `T${i}`,
      handoffId: 'H',
      sessionId: SESSION,
      preparedAt: i + 1,
      fence: i + 1,
      acquisitionGeneration: `G${i}`,
      sourceLinkId: `L${i - 1}`,
      predecessorTargetId: i > 1 ? `T${i - 1}` : null,
      targetLink,
      firstInputId: `P${i}`
    }
    records.push(target, {
      kind: 'delivery',
      id: `D${i}`,
      handoffId: 'H',
      sessionId: SESSION,
      targetId: `T${i}`,
      mode: 'inline',
      carrierInputId: `P${i}`,
      preparedAt: i + 1,
      selection,
      writeStartedAt: i + 1,
      outcome: { kind: 'unknown', at: i + 1, reason: 'lost reply' }
    })
  }
  const owner = agentSessionRecordFixture({
    sessionId: SESSION,
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/test' },
    providerHandleChain: chain
  })
  db.prepare('INSERT INTO agent_session_records (session_id, record_json) VALUES (?, ?)').run(
    SESSION,
    JSON.stringify(encodeAgentSessionRecord(owner))
  )
  const insert = db.prepare(
    'INSERT INTO agent_session_context_transfers (id,session_id,handoff_id,kind,format,record_json) VALUES (?,?,?,?,1,?)'
  )
  for (const record of records) {
    insert.run(record.id, SESSION, record.handoffId, record.kind, JSON.stringify(record))
  }
  const work = instrumentContextTransferFacts(db)
  writeContextTransferJournalReceipts(
    db,
    createJournalReducerState(SESSION, 'e'),
    createJournalReducerState(SESSION, 'e'),
    [
      {
        kind: 'dispatch',
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch: 'e',
        seq: 3,
        fence: retained + 1,
        ts: retained + 2,
        clientMessageId: 'Q',
        state: 'accepted',
        providerItemId: null,
        reason: null
      }
    ],
    retained + 2,
    new ContextTransferFacts(db, SESSION)
  )
  return { ...work.counts }
}

it('passes retained unresolved carriers with the same keyed work at any count', async () => {
  const small = await unrelatedBatchWork(20)
  const large = await unrelatedBatchWork(200)
  expectSameKeyedWork(small, large)
})
