import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { expect, it, vi } from 'vitest'
import { readAgentMessageSource } from '../../../../../shared/agent-session/agent-session-message-source'
import { agentMessageHeading } from '../../../../../shared/agent-session/agent-message-presentation'
import { structuredMailSource, type MailSourceMessage } from './structured-mail-source'

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
        senderSnapshot: () => ({ name: 'Sender', agent: null }),
        batch: addresses.map<MailSourceMessage>((address, i) => ({
          id: `m${i}`,
          from_handle: address,
          run_id: run.id,
          type: report ? 'worker_done' : 'status',
          payload: report ? JSON.stringify({ dispatchId: report }) : null
        }))
      })
    expect(mail('term_coord', ['term_worker']).senders[0].relation).toBe('worker')
    expect(agentMessageHeading(mail('term_coord', ['term_worker']), { blocks: [] })).toBe('worker')
    expect(mail('term_worker', ['term_coord'], worker.id).senders[0].relation).toBe('coordinator')
    expect(
      agentMessageHeading(mail('term_worker', ['term_coord'], worker.id), { blocks: [] })
    ).toBe('coordinator')
    expect(mail('term_coord', ['term_child']).senders[0].relation).toBe('none')
    const delivered = mail('term_worker', ['term_child', 'term_peer'], worker.id)
    db.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = ?").run(child.id)
    const reload = readAgentMessageSource(JSON.parse(JSON.stringify(delivered)))!
    expect(reload.senders.map((sender) => sender.relation)).toEqual(['worker', 'none'])
    expect(agentMessageHeading(reload, { blocks: [] })).toBe('generic')
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
        senderSnapshot: () => ({ name: 'Sender', agent: null })
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
