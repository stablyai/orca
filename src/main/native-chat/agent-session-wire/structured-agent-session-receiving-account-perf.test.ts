import { randomUUID } from 'node:crypto'
import * as conversationView from '../../../shared/agent-session-conversation-view'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { conversationRecordReader } from '../../runtime/orchestration/structured-session-lineage'
import { structuredSessionMailReach } from '../../runtime/orchestration/structured-session-mail-address'
import { dispatchReportMailbox } from '../../runtime/orchestration/dispatch-report-mailbox'
import { structuredMailNotice } from '../../runtime/orchestration/structured-mail-source'
import { observeReceivingSql } from './structured-agent-session-receiving-sql.test-support'
import {
  agentSessionRecordFixture,
  agentSessionLeaseFixture
} from '../../../shared/agent-session-record.test-fixture'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionRecordStore
} from '../../runtime/agent-session-record-store-test-harness'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'
import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import { expect, it, vi } from 'vitest'
import {
  createReceivingAccountFixture,
  RECEIVING_A,
  SELECTED_B
} from './structured-agent-session-receiving-account.test-support'
import { StructuredNativeResponses } from './structured-agent-session-native-responses'
import { structuredAgentSessionReceivingAccount } from './structured-agent-session-receiving-account'
const ordinary: AgentJournalMessageItem = {
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text: 'ordinary' }]
}
it.each([10, 100])(
  'indexes %i native results once and reads only changed journal rows thereafter',
  async (n) => {
    const f = await createReceivingAccountFixture()
    try {
      const started = performance.now()
      const messages = Array.from({ length: n }, () => f.finish(f.start()))
      for (const message of messages) {
        const next = await f.submit(f.body(message))
        await f.turn(next.clientMessageId, 'completed')
      }
      const visits = vi.spyOn(f.journal, 'visitItemsWithLinkage')
      const submissions = vi.spyOn(f.journal, 'submissions')
      const rows = vi.spyOn(f.journal, 'readSince')
      const keys = vi.spyOn(f.journal, 'canonicalItemId')
      const projection = new StructuredNativeResponses()
      expect(projection.read(f.journal).disposed.size).toBe(n)
      expect(visits).toHaveBeenCalledTimes(1)
      expect(submissions).toHaveBeenCalledTimes(1)
      keys.mockClear()
      for (let i = 0; i < n; i += 1) {
        projection.read(f.journal)
      }
      expect(keys).not.toHaveBeenCalled()
      expect(rows).not.toHaveBeenCalled()
      const next = await f.submit(ordinary, 'client')
      keys.mockClear()
      projection.read(f.journal)
      expect(keys.mock.calls.length).toBeLessThanOrEqual(8)
      expect(rows).toHaveBeenCalledTimes(1)
      expect(rows.mock.results[0]?.value).toMatchObject({ ok: true })
      expect(visits).toHaveBeenCalledTimes(1)
      expect(submissions).toHaveBeenCalledTimes(1)
      expect(next.clientMessageId).toBeTruthy()
      for (let i = 1; i <= n; i += 1) {
        await f.journal.appendTombstone(
          { provider: 'claude', sessionId: 'parent-provider', uuid: `turn-receiving-${i}` },
          { fence: 2 }
        )
      }
      projection.read(f.journal)
      expect(visits).toHaveBeenCalledTimes(2)
      expect(submissions).toHaveBeenCalledTimes(2)
      expect(rows).toHaveBeenCalledTimes(2)
      process.stdout.write(
        `receiving-account journal corpus=${n} initialVisits=1 initialSubmissionLists=1 unchangedReads=${n} incrementalReads=1 destructiveBatchRebuilds=1 elapsedMs=${(performance.now() - started).toFixed(3)}\n`
      )
    } finally {
      await f.dispose()
    }
  }
)

it.each([10, 100])(
  'bounds real native mailbox enumeration at %i results despite unrelated history',
  async (n) => {
    const f = await createReceivingAccountFixture()
    try {
      const began = performance.now()
      for (let i = 0; i < n; i += 1) {
        const next = await f.submit(f.body(f.finish(f.start())))
        await f.turn(next.clientMessageId, 'completed')
      }
      for (let i = 0; i < n * 10; i += 1) {
        f.db.createTask({ spec: 'unrelated corpus', runId: f.run.id })
      }
      const observed = observeReceivingSql(f.db)
      const selected = await structuredAgentSessionReceivingAccount(f.deps, f.record, f.session)
      expect(selected.home).toEqual(SELECTED_B)
      // Scoped reach + current mailbox discovery + canonical report routing are constant preparations.
      expect(observed.measurements.prepares).toBeLessThanOrEqual(20)
      expect(observed.measurements.allRows).toBeLessThanOrEqual(n + 4)
      expect(observed.measurements.plans.length).toBeGreaterThan(0)
      expect(
        observed.measurements.plans.filter((detail) =>
          /\bSCAN (?:run|child|task|parent|messages|dispatch_contexts|agent_session_records)\b/.test(
            detail
          )
        )
      ).toEqual([])
      observed.stop()
      process.stdout.write(
        `receiving-account native results=${n} unrelatedTasks=${n * 10} statements=${observed.measurements.prepares} enumerated=${observed.measurements.allRows} elapsedMs=${(performance.now() - began).toFixed(3)}\n`
      )
    } finally {
      await f.dispose()
    }
  }
)

it.each([10, 100])(
  'reads %i historical clear links through the real record index, independent of other chats',
  async (n) => {
    const f = await createReceivingAccountFixture()
    try {
      const began = performance.now()
      const predecessors = Array.from({ length: n }, (_, i) => ({
        ...agentSessionRecordFixture(
          agentSessionLeaseFixture({ sessionId: `clear-source-${i}`, runtimeFence: 2 })
        ),
        conversationCommand: {
          command: 'clear' as const,
          state: 'completed' as const,
          phase: 'committed' as const,
          runtimeFence: 2,
          callerKey: 'legacy-client',
          operationId: '1800000000000-00000000000000000000000000000003',
          replacementSessionId: i === n - 1 ? f.root : `clear-source-${i + 1}`
        }
      }))
      const unrelated = Array.from({ length: n * 10 }, (_, i) =>
        agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: `unrelated-chat-${i}` }))
      )
      await seedTestAgentSessionRecordStore(f.rig.root, {
        records: [f.record, ...predecessors, ...unrelated]
      })
      const store = await openTestAgentSessionRecordStore(f.rig.root)
      const db = openTestJournalHostDatabase(f.rig.root).db
      const prepare = db.prepare.bind(db)
      let reads = 0
      let enumerated = 0
      const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
        const statement = prepare(sql)
        const all = statement.all.bind(statement)
        vi.spyOn(statement, 'all').mockImplementation((...args) => {
          reads += 1
          const rows = all(...args)
          enumerated += rows.length
          const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args)
          expect(
            plan.some(
              (row) =>
                typeof row.detail === 'string' &&
                row.detail.includes('idx_agent_session_clear_successor')
            )
          ).toBe(true)
          return rows
        })
        return statement
      })
      const lineage = store.lineageRecords(f.record)
      expect(lineage.map((record) => record.sessionId)).toEqual([
        ...predecessors.map((record) => record.sessionId),
        f.root
      ])
      expect(spy).toHaveBeenCalledTimes(1)
      expect(reads).toBe(n + 1)
      expect(enumerated).toBe(n)
      spy.mockRestore()
      process.stdout.write(
        `receiving-account clearLinks=${n} unrelatedChats=${n * 10} indexPrepares=1 lookups=${reads} enumerated=${enumerated} elapsedMs=${(performance.now() - began).toFixed(3)}\n`
      )
    } finally {
      await f.dispose()
    }
  }
)

it.each([
  { l: 10, u: 100 },
  { l: 100, u: 100 },
  { l: 10, u: 1000 },
  { l: 100, u: 1000 }
])(
  'bounds canonical receiving projections for lineage $l with $u unrelated chats',
  async ({ l, u }) => {
    const f = await createReceivingAccountFixture()
    try {
      const ids = Array.from({ length: l - 1 }, () => testOrcaSessionId(randomUUID()))
      const predecessors = ids.map((sessionId, i) => ({
        ...agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId, runtimeFence: 2 })),
        conversationCommand: {
          command: 'clear' as const,
          state: 'completed' as const,
          phase: 'committed' as const,
          runtimeFence: 2,
          callerKey: 'legacy-client',
          operationId: '1800000000000-00000000000000000000000000000003',
          replacementSessionId: ids[i + 1] ?? f.root
        }
      }))
      const unrelated = Array.from({ length: u }, () =>
        agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: randomUUID() }))
      )
      await seedTestAgentSessionRecordStore(f.rig.root, {
        records: [f.record, ...predecessors, ...unrelated]
      })
      const store = await openTestAgentSessionRecordStore(f.rig.root)
      const record = store.requireWritableRecord(f.root)
      expect(store.lineageRecords(record).map((item) => item.sessionId)).toEqual([...ids, f.root])
      const root = ids[0]
      if (!root) {
        throw new Error('clear lineage requires a predecessor')
      }
      const original = store.getConversation(root)
      if (!original) {
        throw new Error('canonical lineage root missing')
      }
      const reader = conversationRecordReader(store)
      expect(structuredSessionMailReach(reader, original, f.db, reader)).toMatchObject({
        kind: 'reachable',
        session: { sessionId: f.root }
      })
      const run = f.db.createRun({
        objective: 'clear-lineage native work',
        coordinatorHandle: null,
        coordinatorPaneKey: null,
        coordinatorOrcaSessionId: root
      })
      const child = f.db.createStartingWorkerDispatch({
        taskSpec: 'report to the current clear successor',
        taskRunId: run.id,
        taskCreatedByRunGeneration: run.consumer_generation,
        creator: { kind: 'session', orcaSessionId: root },
        maxDepth: 9,
        startOptions: {}
      })
      expect(dispatchReportMailbox(f.db, child.dispatch)).toBe(`run:${run.id}`)
      const all = vi.spyOn(store, 'listRecords').mockImplementation(() => {
        throw new Error('global raw history scan')
      })
      const conversations = vi.spyOn(store, 'listConversations').mockImplementation(() => {
        throw new Error('global conversation scan')
      })
      const projection = vi.spyOn(conversationView, 'agentSessionConversationView')
      const decide = async (expected: typeof RECEIVING_A) => {
        projection.mockClear()
        const observed = observeReceivingSql(f.db)
        try {
          expect(
            (await structuredAgentSessionReceivingAccount({ ...f.deps, store }, record, f.session))
              .home
          ).toEqual(expected)
          // Array.map supplies index/array; direct getConversation projections take one argument.
          const mapped = projection.mock.calls.filter((args) => args.length > 1).length
          expect(mapped).toBeGreaterThan(0)
          expect(mapped).toBeLessThanOrEqual(3 * l)
          expect(observed.measurements.prepares).toBeLessThanOrEqual(20)
          expect(observed.measurements.allRows).toBeLessThanOrEqual(8)
          expect(observed.measurements.plans.length).toBeGreaterThan(0)
          expect(
            observed.measurements.plans.filter((detail) =>
              /\bSCAN (?:run|child|task|parent|messages|dispatch_contexts|agent_session_records)\b/.test(
                detail
              )
            )
          ).toEqual([])
          expect(all).not.toHaveBeenCalled()
          expect(conversations).not.toHaveBeenCalled()
          process.stdout.write(
            `receiving-projection lineage=${l} unrelated=${u} mapped=${mapped} bound=${3 * l} sql=${observed.measurements.prepares} rows=${observed.measurements.allRows} home=${expected.path}\n`
          )
        } finally {
          observed.stop()
        }
      }
      await decide(RECEIVING_A)
      const message = f.db.commitWorkerDoneMessageMutation(() => {
        f.db.completeDispatch(child.dispatch.id)
        return f.db.insertMessage({
          from: 'structworker_e7f53907-0cde-40b9-81c5-d18eb66c07a4',
          to: dispatchReportMailbox(f.db, child.dispatch),
          runId: run.id,
          type: 'worker_done',
          subject: 'completed',
          payload: JSON.stringify({
            dispatchId: child.dispatch.id,
            taskId: child.task.id,
            outcome: 'succeeded'
          }),
          deliveryContract: 'current_delivery'
        })
      })
      await decide(RECEIVING_A)
      const next = await f.submit(
        structuredMailNotice({
          db: f.db,
          mailboxHandle: `run:${run.id}`,
          dispatchId: null,
          batch: { messages: [message], heldDeliveryId: undefined },
          cliCommand: 'orca-dev',
          senderName: () => null
        })
      )
      await decide(RECEIVING_A)
      await f.turn(next.clientMessageId, 'completed')
      await decide(SELECTED_B)
      expect(f.db.getMessageById(message.id)?.read).toBe(0)
    } finally {
      vi.restoreAllMocks()
      await f.dispose()
    }
  }
)
