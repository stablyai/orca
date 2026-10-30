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

import { z } from 'zod'
import { OrchestrationDb } from './db'
import { locateOrchestrationParty } from './orchestration-party-location'

describe('who delivered mail is from', () => {
  it('keeps sender recovery readable by a client from before full-content mail', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const message = db.insertMessage({
        from: 'term_previous',
        to: 'run:r1',
        subject: 'report',
        senderPaneKey: 'pane-worker'
      })
      const source = structuredMailSource({
        db,
        mailboxHandle: message.to_handle,
        dispatchId: null,
        message,
        senderName: () => 'Worker'
      })
      // The published mail schema before full-content delivery; unknown fields are stripped.
      const legacy = z
        .object({
          message: z.literal('mail-notice'),
          mailbox: z.string(),
          dispatchId: z.string().nullable(),
          messages: z.array(
            z.object({ messageId: z.string(), runId: z.string(), from: z.string() })
          )
        })
        .parse(source.orchestration)
      const messageIds = legacy.messages
        .filter((mail) => mail.from === 'term_previous')
        .map((mail) => mail.messageId)
      expect(
        locateOrchestrationParty(
          'term_previous',
          {
            db,
            records: null,
            terminalPaneKey: () => null,
            terminalHandleForPaneKey: (pane) => (pane === 'pane-worker' ? 'term_current' : null)
          },
          messageIds
        )
      ).toEqual({ location: { kind: 'terminal', handle: 'term_current' } })
    } finally {
      db.close()
    }
  })

  it('bounds a snapshot name, and a naming failure costs only the name', () => {
    const named = (senderName: (party: unknown) => string | null) =>
      structuredMailSource({
        db: null,
        mailboxHandle: 'run:r1',
        dispatchId: null,
        message: { id: 'm1', from_handle: 'term_a', run_id: 'r1', type: 'status', payload: null },
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
      address: string,
      dispatchId: string | null = null,
      report?: string
    ) =>
      structuredMailSource({
        db,
        mailboxHandle: recipient,
        dispatchId,
        senderName: () => 'Sender',
        message: {
          id: 'm1',
          from_handle: address,
          run_id: run.id,
          type: report ? 'worker_done' : 'status',
          payload: report ? JSON.stringify({ dispatchId: report }) : null
        }
      })
    expect(mail('term_coord', 'term_worker').senders[0].relation).toBe('worker')
    expect(agentMessageHeading(mail('term_coord', 'term_worker'))).toBe('worker')
    expect(mail('term_worker', 'term_coord', worker.id).senders[0].relation).toBe('coordinator')
    expect(agentMessageHeading(mail('term_worker', 'term_coord', worker.id))).toBe('coordinator')
    expect(mail('term_coord', 'term_child').senders[0].relation).toBe('none')
    const delivered = [
      mail('term_worker', 'term_child', worker.id),
      mail('term_worker', 'term_peer', worker.id)
    ]
    db.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?").run(child.id)
    const reload = delivered.map((source) =>
      readAgentMessageSource(JSON.parse(JSON.stringify(source)))!
    )
    expect(reload.map((source) => source.senders[0].relation)).toEqual(['worker', 'none'])
    expect(reload.map((source) => agentMessageHeading(source))).toEqual(['worker', 'generic'])
    expect(mail('term_worker', 'term_child', worker.id).senders[0].relation).toBeUndefined()
    expect(mail('term_worker', 'term_child', worker.id, child.id).senders[0].relation).toBe(
      'worker'
    )
    expect(mail('term_coord', 'unknown').senders[0].relation).toBeUndefined()
    db.db
      .prepare('UPDATE dispatch_contexts SET creator_handle = NULL, depth = 1 WHERE id = ?')
      .run(worker.id)
    expect(mail('term_coord', 'term_worker').senders[0].relation).toBeUndefined()
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
    expect(
      structuredMailSource({
        db,
        mailboxHandle: 'term_coord',
        dispatchId: null,
        message: good,
        senderName: () => 'Sender'
      }).senders[0].relation
    ).toBe('worker')
    for (const bad of [
      { ...good, id: 'foreign', run_id: 'missing' },
      { ...good, id: 'wrong-report', payload: JSON.stringify({ dispatchId: child.id }) },
      { ...good, id: 'invalid', payload: '{' }
    ]) {
      const source = structuredMailSource({
        db,
        mailboxHandle: 'term_coord',
        dispatchId: null,
        message: bad,
        senderName: () => 'Sender'
      })
      expect(source.senders[0].relation).toBeUndefined()
      expect(source.orchestration).toMatchObject({
        messages: [{ messageId: bad.id }]
      })
    }
    db.db
      .prepare('UPDATE dispatch_contexts SET host_scope = ? WHERE id = ?')
      .run(JSON.stringify({ kind: 'ssh', targetId: 'elsewhere' }), worker.id)
    expect(mail('term_coord', 'term_worker').senders[0].relation).toBeUndefined()
  } finally {
    vi.restoreAllMocks()
    db.close()
  }
})

it.each([100, 1000])(
  'counts real canonical record work per ordinary report with %i workers',
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
        const sources = batch.map((message) =>
          structuredMailSource({
            db,
            mailboxHandle: `orca_session_id:${coordinator}`,
            dispatchId: null,
            message,
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
        )
        // Each ordinary card resolves its own sender and informational relation.
        expect(visits).toBe((evidence === 'unknown' ? 1 : 8) * n * records.length)
        expect(relation).toHaveBeenCalledTimes(n)
        expect(batchReads).toBe(n)
        expect(sources[0].senders[0].party.orcaSessionId).toBe(sessions[0])
        expect(
          sources.map((source) => [source.senders[0].name, source.senders[0].relation])
        ).toEqual(
          Array.from({ length: n }, (_, i) => [
            `Worker ${distinct ? i % 10 : 0}`,
            evidence === 'unknown' ? undefined : 'worker'
          ])
        )
        expect(
          sources.every(
            (source) =>
              source.orchestration?.message === 'mail-notice' &&
              source.orchestration.messages.length === 1
          )
        ).toBe(true)
      }
    } finally {
      vi.restoreAllMocks()
      db.close()
    }
  }
)
