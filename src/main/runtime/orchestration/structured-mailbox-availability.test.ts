import { afterEach, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { OrchestrationStructuredMailboxPointerDelivery } from './structured-mailbox-pointer-delivery'
import { structuredMailAttempt } from './structured-mail-custody'
import type {
  StructuredMailboxPointerHost,
  StructuredMailSendState
} from './structured-mailbox-pointer-host-contract'
import { sessionCrewChanges } from './crew/crew-changes'
import { createStructuredMailboxPointerHost } from './structured-mailbox-pointer-host'
import { structuredMailboxCustody } from './structured-session-mail-target'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../../shared/agent-session/lifecycle/agent-session-record.test-fixture'
import { agentSessionConversationView } from '../../../shared/agent-session/lifecycle/agent-session-conversation-view'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'

const hostRef: { current: unknown } = { current: null }
vi.mock('../../native-chat/agent-session-wire/structured-agent-session-registry', () => ({
  getStructuredAgentSessionHost: () => hostRef.current
}))

const databases: OrchestrationDb[] = []
afterEach(() => {
  hostRef.current = null
  for (const db of databases.splice(0)) {
    db.close()
  }
})
const drain = async () => {
  for (let n = 0; n < 8; n++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
function database() {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  return db
}

it('observes reserved reports in a replacement database after an older settlement completes', async () => {
  function reservedDatabase() {
    const db = database()
    const run = db.createRun({
      objective: 'reset',
      coordinatorHandle: 'coord',
      coordinatorPaneKey: null
    })
    const row = db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: 'mailbox',
      subject: 'report'
    })
    expect(db.reserveStructuredMailSend(structuredMailAttempt('mailbox', row.id, 'session'))).toBe(
      true
    )
    return { db, row }
  }
  const old = reservedDatabase()
  const fresh = reservedDatabase()
  let db = old.db
  let finish: ((state: StructuredMailSendState) => void) | undefined
  const attachment = {}
  const scalar = { host: attachment, fence: 1, key: 'epoch1:0', stopAt: null }
  const host: StructuredMailboxPointerHost = {
    attachment: () => attachment,
    currentFence: () => 1,
    readEligibility: () => scalar,
    openEligibility: async () => scalar,
    watchJournal: () => () => {},
    wakeQueue: () => {},
    withdraw: async () => true,
    observe: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<StructuredMailSendState>((resolve) => {
            finish = resolve
          })
      )
      .mockResolvedValue({ kind: 'absent' }),
    send: vi.fn(async () => ({ kind: 'sent' as const, state: 'accepted' as const }))
  }
  const delivery = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db,
    getMessageWaiters: () => undefined,
    resolveStructuredTarget: () => ({ sessionId: 'session', dispatchId: null }),
    mailboxEnded: () => false,
    getCliCommand: () => 'orca-dev',
    senderSnapshot: () => ({ name: null, agent: null }),
    host
  })
  try {
    delivery.deliverForHandle('mailbox')
    expect(finish).toBeTypeOf('function')
    delivery.reset()
    db = fresh.db
    delivery.deliverForHandle('mailbox')
    finish?.({ kind: 'unreadable' })
    await drain()
    expect(host.observe).toHaveBeenCalledTimes(2)
    expect(host.send).toHaveBeenCalledTimes(1)
    expect(fresh.db.getMessageById(fresh.row.id)?.read).toBe(1)
    delivery.deliverForHandle('mailbox', undefined, 'service')
    await drain()
    expect(host.send).toHaveBeenCalledTimes(1)
  } finally {
    delivery.reset()
  }
})

it.each(['unverifiable', 'elsewhere', 'ended'] as const)(
  'retains a host availability wake only while mailbox ownership is %s',
  async (custody) => {
    const db = database()
    const sessionId = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
    const record = agentSessionConversationView(
      agentSessionRecordFixture(agentSessionLeaseFixture({ sessionId, runtimeKind: 'native' }))
    )
    const store = {
      getConversation: () => record,
      listConversations: () => [record],
      getVisibleSessionTabIndex: () => ({ present: true, sessionIds: [sessionId] })
    }
    function install(stopAt: number | null) {
      hostRef.current = {
        deps: { store },
        reads: {
          readQueueStop: () => ({
            epoch: 'epoch1',
            stopSequence: stopAt === null ? 0 : 1,
            stopAt,
            resumedSequence: stopAt === null ? 2 : 0,
            clearedSequence: 0
          })
        },
        observeJournalPublications: () => () => {}
      }
      sessionCrewChanges.notify()
    }
    install(Date.parse('2026-11-03T12:00:00Z'))
    const run = db.createRun({
      objective: 'host replacement',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: sessionId
    })
    const mailbox = `run:${run.id}`
    const row = db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: mailbox,
      subject: 'held report'
    })
    db.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run('2026-11-03 11:59:59', row.id)
    const adapter = createStructuredMailboxPointerHost()
    const send = vi.spyOn(adapter, 'send').mockResolvedValue({ kind: 'sent', state: 'accepted' })
    let ended = false
    let elsewhere = false
    const delivery = new OrchestrationStructuredMailboxPointerDelivery({
      getDb: () => db,
      getMessageWaiters: () => undefined,
      resolveStructuredTarget: () => {
        const current = structuredMailboxCustody(mailbox, db)
        return typeof current === 'object' ? current : null
      },
      mailboxEnded: () => ended,
      unresolvedCustody: () => (elsewhere ? 'elsewhere' : 'unverifiable'),
      getCliCommand: () => 'orca-dev',
      senderSnapshot: () => ({ name: null, agent: null }),
      host: adapter
    })
    try {
      delivery.deliverForHandle(mailbox)
      await drain()
      expect(send).not.toHaveBeenCalled()
      ended = custody === 'ended'
      elsewhere = custody === 'elsewhere'
      hostRef.current = null
      sessionCrewChanges.notify()
      await drain()
      // Exercise both the watched pass and the public no-owner shortcut.
      delivery.deliverForHandle(mailbox, undefined, 'service')
      await drain()
      expect(delivery['parking'].parkedFor(sessionId)).toHaveLength(
        custody === 'unverifiable' ? 1 : 0
      )
      install(null)
      await drain()
      expect(send).toHaveBeenCalledTimes(custody === 'unverifiable' ? 1 : 0)
      expect(db.getMessageById(row.id)?.read).toBe(custody === 'unverifiable' ? 1 : 0)
    } finally {
      delivery.reset()
      hostRef.current = null
      sessionCrewChanges.notify()
    }
  }
)
