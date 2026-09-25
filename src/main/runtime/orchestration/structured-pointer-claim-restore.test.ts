import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { OrcaRuntimeWithGetPtyRecordForPaneKey } from '../orca-runtime-get-pty-record-for-pane-key'
import { releaseRestoredStructuredPointerClaims } from './structured-pointer-claim-restore'
import { resolveStructuredPointerOperation } from './structured-pointer-operation-id'
import { testOrcaSessionId } from '../../../shared/orca-session-address-test-fixture'

const SESSION = testOrcaSessionId('4a1f6c2e-8b3d-4e7a-9c15-0d2b6e8f1a37')
const BODY = { kind: 'message' as const, role: 'user' as const, blocks: [] }

let db: OrchestrationDb
let mailbox: string

beforeEach(() => {
  db = new OrchestrationDb(':memory:')
  mailbox = `run:${db.createRun({ objective: 'o', coordinatorHandle: null, coordinatorPaneKey: null, coordinatorOrcaSessionId: SESSION }).id}`
})

afterEach(() => {
  db.close()
})

function mail(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) =>
      db.insertMessage({ from: 'term_worker', to: mailbox, subject: `m${index}`, type: 'status' })
        .id
  )
}

/** What the structured lane leaves when the host admits a pointer as pending: stamped, row kept. */
function pendingPointer(ids: string[], stamp: string): void {
  resolveStructuredPointerOperation({
    db,
    mailboxHandle: mailbox,
    sessionId: SESSION,
    body: BODY,
    messageIds: ids
  })
  db.markAsDelivered(ids)
  db.db
    .prepare(`UPDATE messages SET delivered_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`)
    .run(stamp, ...ids)
}

function undelivered(): string[] {
  return db.getUndeliveredUnreadMessages(mailbox, undefined, {}).map((message) => message.id)
}

describe('a structured pointer claim left by an earlier process', () => {
  it('gives its batch back and drops the claim, so the mailbox is pointed again', () => {
    // The strand this pins: a pointer admitted as pending stamps its batch delivered, and only an
    // in-memory waiter gave it back; after a restart nothing ever pointed that mail again.
    const batch = mail(2)
    pendingPointer(batch, '2026-09-24 10:00:00')

    expect(releaseRestoredStructuredPointerClaims(db)).toEqual([mailbox])
    expect(undelivered()).toEqual(batch)
    expect(db.getStructuredPointerOperation(mailbox)).toBeUndefined()
  })

  it('gives back only its own batch when an earlier pointer was stamped in the same second', () => {
    const earlier = mail(1)
    db.markAsDelivered(earlier)
    db.db
      .prepare('UPDATE messages SET delivered_at = ? WHERE id = ?')
      .run('2026-09-24 10:00:00', earlier[0])
    const batch = mail(2)
    pendingPointer(batch, '2026-09-24 10:00:00')

    releaseRestoredStructuredPointerClaims(db)
    expect(undelivered()).toEqual(batch)
  })

  it('keeps a claim whose batch was never stamped: its id is the retry key', () => {
    const batch = mail(1)
    resolveStructuredPointerOperation({
      db,
      mailboxHandle: mailbox,
      sessionId: SESSION,
      body: BODY,
      messageIds: batch
    })

    expect(releaseRestoredStructuredPointerClaims(db)).toEqual([])
    expect(db.getStructuredPointerOperation(mailbox)).toBeDefined()
  })
})

describe('opening the orchestration database', () => {
  it('releases restored structured pointer claims before scanning for undelivered mail', () => {
    const batch = mail(1)
    pendingPointer(batch, '2026-09-24 10:00:00')
    const scheduled: string[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a prototype-only probe; every field the method reads is assigned below.
    const runtime = Object.assign(Object.create(OrcaRuntimeWithGetPtyRecordForPaneKey.prototype), {
      _orchestrationDb: db,
      mailPointerRepointScheduler: { schedule: (handle: string) => scheduled.push(handle) }
    }) as { scheduleRestoredMessageRepoints: () => void }

    runtime.scheduleRestoredMessageRepoints()

    expect(undelivered()).toEqual(batch)
    expect(scheduled).toEqual([mailbox])
  })
})
