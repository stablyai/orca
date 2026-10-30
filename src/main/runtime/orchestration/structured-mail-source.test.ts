import { OrchestrationDb } from './db'
import { describe, expect, it, vi } from 'vitest'
import { readAgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import { agentMessageHeading } from '../../../shared/agent-session/agent-message-presentation'
import {
  agentSessionConversationView,
  type AgentSessionConversationView
} from '../../../shared/agent-session-conversation-view'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session-record.test-fixture'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'
import { orchestrationSenderName } from './orchestration-sender-name'
import * as relations from './agent-message-relation'
import * as lineage from './structured-session-lineage'
import { structuredMailSource, type MailSourceMessage } from './structured-mail-source'

const SESSION = '4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37'

describe('who delivered mail is from', () => {
  it("names each sender once, without the pane key that would open its mailbox, and each message's own sender", () => {
    // No database: a terminal handle and a session address name their party by themselves.
    const source = structuredMailSource({
      db: null,
      mailboxHandle: 'run:r1',
      dispatchId: null,
      batch: [
        { id: 'm1', from_handle: 'term_a', run_id: 'r1', type: 'status', payload: null },
        {
          id: 'm2',
          from_handle: `orca_session_id:${SESSION}`,
          run_id: 'r2',
          type: 'status',
          payload: null
        },
        { id: 'm3', from_handle: 'term_a', run_id: 'r1', type: 'status', payload: null }
      ],
      senderName: (party) => (party.terminalHandle === 'term_a' ? 'Build tab' : null)
    })
    expect(source).toEqual({
      kind: 'agent',
      senders: [
        {
          party: { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null },
          name: 'Build tab'
        },
        {
          party: {
            address: `orca_session_id:${SESSION}`,
            terminalHandle: null,
            orcaSessionId: SESSION
          },
          name: null
        }
      ],
      orchestration: {
        message: 'mail-notice',
        mailbox: 'run:r1',
        dispatchId: null,
        messages: [
          { messageId: 'm1', runId: 'r1', from: 'term_a' },
          { messageId: 'm2', runId: 'r2', from: `orca_session_id:${SESSION}` },
          { messageId: 'm3', runId: 'r1', from: 'term_a' }
        ]
      }
    })
  })

  it('bounds a snapshot name, and a naming failure costs only the name', () => {
    const named = (senderName: (party: unknown) => string | null) =>
      structuredMailSource({
        db: null,
        mailboxHandle: 'run:r1',
        dispatchId: null,
        batch: [{ id: 'm1', from_handle: 'term_a', run_id: 'r1', type: 'status', payload: null }],
        senderName
      }).senders[0]?.name
    expect(named(() => `  Build\n${'x'.repeat(400)}`)).toHaveLength(200)
    expect(named(() => '   ')).toBeNull()
    expect(
      named(() => {
        throw new Error('records unavailable')
      })
    ).toBeNull()
  })
})

it('snapshots immediate relations across completion/reload and keeps unknown evidence non-gating', () => {
  const db = new OrchestrationDb(':memory:')
  try {
    const run = db.createRun({
      objective: 'cards',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    })
    const assign = (handle: string, creator: string) =>
      db.createDispatchContext({
        taskId: db.createTask({ runId: run.id, spec: handle }).id,
        assigneeHandle: handle,
        creator: { kind: 'terminal', handle: creator },
        maxDepth: 8
      })
    const worker = assign('term_worker', 'term_coord')
    assign('term_peer', 'term_coord')
    const child = assign('term_child', 'term_worker')
    const mail = (
      recipient: string,
      addresses: string[],
      dispatchId: string | null = null,
      report?: string
    ) =>
      structuredMailSource({
        db,
        mailboxHandle: recipient,
        dispatchId,
        senderName: () => 'Sender',
        batch: addresses.map<MailSourceMessage>((address, i) => ({
          id: `m${i}`,
          from_handle: address,
          run_id: run.id,
          type: report ? 'worker_done' : 'status',
          payload: report ? JSON.stringify({ dispatchId: report }) : null
        }))
      })
    expect(mail('term_coord', ['term_worker']).senders[0].relation).toBe('worker')
    expect(agentMessageHeading(mail('term_coord', ['term_worker']))).toBe('worker')
    expect(mail('term_worker', ['term_coord'], worker.id).senders[0].relation).toBe('coordinator')
    expect(agentMessageHeading(mail('term_worker', ['term_coord'], worker.id))).toBe('coordinator')
    expect(mail('term_coord', ['term_child']).senders[0].relation).toBe('none')
    const delivered = mail('term_worker', ['term_child', 'term_peer'], worker.id)
    db.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?").run(child.id)
    const reload = readAgentMessageSource(JSON.parse(JSON.stringify(delivered)))!
    expect(reload.senders.map((sender) => sender.relation)).toEqual(['worker', 'none'])
    expect(agentMessageHeading(reload)).toBe('generic')
    expect(mail('term_worker', ['term_child'], worker.id).senders[0].relation).toBeUndefined()
    expect(mail('term_worker', ['term_child'], worker.id, child.id).senders[0].relation).toBe(
      'worker'
    )
    expect(mail('term_coord', ['unknown']).senders[0].relation).toBeUndefined()
    db.db
      .prepare('UPDATE dispatch_contexts SET creator_handle = NULL, depth = 1 WHERE id = ?')
      .run(worker.id)
    expect(mail('term_coord', ['term_worker']).senders[0].relation).toBeUndefined()
    db.db
      .prepare('UPDATE dispatch_contexts SET creator_handle = ? WHERE id = ?')
      .run('term_coord', worker.id)
    const good: MailSourceMessage = {
      id: 'good',
      from_handle: 'term_worker',
      run_id: run.id,
      type: 'worker_done',
      payload: JSON.stringify({ dispatchId: worker.id })
    }
    for (const bad of [
      { ...good, id: 'foreign', run_id: 'missing' },
      { ...good, id: 'wrong-report', payload: JSON.stringify({ dispatchId: child.id }) },
      { ...good, id: 'invalid', payload: '{' }
    ]) {
      const source = structuredMailSource({
        db,
        mailboxHandle: 'term_coord',
        dispatchId: null,
        batch: [good, bad],
        senderName: () => 'Sender'
      })
      expect(source.senders[0].relation).toBeUndefined()
      expect(source.orchestration).toMatchObject({
        messages: [{ messageId: 'good' }, { messageId: bad.id }]
      })
    }
    db.db
      .prepare('UPDATE dispatch_contexts SET host_scope = ? WHERE id = ?')
      .run(JSON.stringify({ kind: 'ssh', targetId: 'elsewhere' }), worker.id)
    expect(mail('term_coord', ['term_worker']).senders[0].relation).toBeUndefined()
  } finally {
    vi.restoreAllMocks()
    db.close()
  }
})

it.each([100, 1000])(
  'bounds real canonical record work for repeated/distinct/unknown notices with %i workers',
  (n) => {
    const db = new OrchestrationDb(':memory:')
    const coordinator = testOrcaSessionId('coordinator')
    const sessions = Array.from({ length: n }, (_, i) => testOrcaSessionId(`worker-${i}`))
    const base = agentSessionConversationView(
      agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId: coordinator }))
    )
    const successor = testOrcaSessionId('cleared-worker')
    const records: AgentSessionConversationView[] = sessions.map((sessionId, i) => ({
      ...base,
      sessionId,
      conversationName: `Worker ${i}`
    }))
    records[0] = {
      ...records[0],
      conversationCommand: {
        command: 'clear',
        state: 'completed',
        phase: 'committed',
        operationId: 'clear',
        callerKey: 'caller',
        replacementSessionId: successor
      }
    }
    records.push(
      { ...base, conversationName: 'Coordinator' },
      { ...base, sessionId: successor, conversationName: 'Worker 0' }
    )
    const bySession = new Map(records.map((record) => [record.sessionId, record]))
    let visits = 0
    records.forEach((record, i) =>
      Object.defineProperty(records, i, {
        get() {
          visits++
          return record
        }
      })
    )
    const reader = {
      listRecords: () => records,
      getRecord: (id: string) => bySession.get(id) ?? null
    }
    vi.spyOn(lineage, 'readAgentSessionRecordStore').mockReturnValue(reader)
    try {
      const run = db.createRun({
        objective: 'cost',
        coordinatorHandle: null,
        coordinatorPaneKey: null,
        coordinatorOrcaSessionId: coordinator
      })
      const dispatches = sessions.slice(0, 10).map((session) =>
        db.createDispatchContext({
          taskId: db.createTask({ runId: run.id, spec: 'work' }).id,
          assigneeHandle: `orca_session_id:${session}`,
          creator: { kind: 'session', orcaSessionId: coordinator },
          maxDepth: 8
        })
      )
      for (const evidence of ['repeated', 'distinct', 'unknown'] as const) {
        const distinct = evidence === 'distinct'
        const relation = vi.spyOn(relations, 'agentMessageRelation')
        relation.mockClear()
        const batch: MailSourceMessage[] = Array.from({ length: n }, (_, i) => ({
          id: `m${i}`,
          from_handle: `orca_session_id:${!distinct || i % 10 === 0 ? successor : sessions[i % 10]}`,
          run_id: evidence === 'unknown' ? 'missing' : run.id,
          type: 'worker_done',
          payload: JSON.stringify({ dispatchId: dispatches[distinct ? i % 10 : 0].id })
        }))
        let batchReads = 0
        batch.forEach((message, i) =>
          Object.defineProperty(batch, i, {
            get() {
              batchReads++
              return message
            }
          })
        )
        visits = 0
        const source = structuredMailSource({
          db,
          mailboxHandle: `orca_session_id:${coordinator}`,
          dispatchId: null,
          batch,
          senderName: (party, report) =>
            orchestrationSenderName(
              party,
              {
                db,
                records: reader,
                chatTab: () => null,
                terminal: () => null,
                generatedTitlesEnabled: true
              },
              report
            )
        })
        const groups = distinct ? 10 : 1
        // Known groups walk canonical records eight times; a missing Run ends after sender canonicalization.
        expect(visits).toBe((evidence === 'unknown' ? 1 : 8 * groups) * records.length)
        expect(relation).toHaveBeenCalledTimes(groups)
        expect(batchReads).toBe(2 * n)
        expect(source.senders[0].party.orcaSessionId).toBe(sessions[0])
        expect(source.senders.map((sender) => [sender.name, sender.relation])).toEqual(
          Array.from({ length: groups }, (_, i) => [
            `Worker ${i}`,
            evidence === 'unknown' ? undefined : 'worker'
          ])
        )
        expect(
          source.orchestration?.message === 'mail-notice' && source.orchestration.messages
        ).toHaveLength(n)
      }
    } finally {
      vi.restoreAllMocks()
      db.close()
    }
  }
)
