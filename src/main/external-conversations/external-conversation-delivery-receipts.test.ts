import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { MUTATION_RECEIPT_MAX_ROWS } from '../runtime/orchestration/mutation-receipt-capacity'
import {
  CONNECTOR_PENDING_RECEIPT_LIMIT,
  DeliveryReceipts
} from './external-conversation-delivery-receipts'
import type { ConversationKey, Delivery } from './external-conversation-types'

const KEY: ConversationKey = { source: 'dev', externalId: 'thread' }
const ORDINARY = {
  callerFingerprint: 'ordinary-user',
  requestId: 'send',
  method: 'orchestration.send',
  payloadHash: 'hash'
}
const never = (): Promise<Delivery> => new Promise(() => {})

const directories: string[] = []
function fileDb(): { path: string; db: OrchestrationDb } {
  const directory = mkdtempSync(join(tmpdir(), 'connector-receipts-'))
  directories.push(directory)
  const path = join(directory, 'orchestration.db')
  return { path, db: new OrchestrationDb(path) }
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('DeliveryReceipts ledger capacity', () => {
  it('cannot fill orchestration’s ledger with a backlog that outlives the process', async () => {
    const { path, db } = fileDb()
    const receipts = new DeliveryReceipts(() => db)
    const answers: Promise<Delivery>[] = []
    for (let i = 0; i < MUTATION_RECEIPT_MAX_ROWS; i++) {
      answers.push(receipts.run(KEY, String(i), 'connector.send', ['hello'], never))
    }
    await expect(answers[CONNECTOR_PENDING_RECEIPT_LIMIT]).resolves.toEqual({
      outcome: 'refused',
      reason: 'delivery_backlog_full'
    })
    expect(db.countPendingMutationReceipts(['connector:dev'])).toBe(CONNECTOR_PENDING_RECEIPT_LIMIT)
    db.close()

    // Process loss, then a restart that never starts connectors.
    const reopened = new OrchestrationDb(path)
    expect(reopened.beginMutationReceipt(ORDINARY).disposition).toBe('started')
    reopened.close()
  })

  it('answers a recorded delivery even when the backlog is full', async () => {
    const { db } = fileDb()
    const receipts = new DeliveryReceipts(() => db)
    for (let i = 0; i < CONNECTOR_PENDING_RECEIPT_LIMIT; i++) {
      void receipts.run(KEY, String(i), 'connector.send', ['hello'], never)
    }
    const joined = receipts.run(KEY, '0', 'connector.send', ['hello'], never)
    const raced = await Promise.race([joined, Promise.resolve('waiting')])
    expect(raced).toBe('waiting')
    db.close()
  })

  it('settles a previous process’s pending deliveries as unknown, without replaying them', async () => {
    const { path, db } = fileDb()
    const before = new DeliveryReceipts(() => db)
    for (let i = 0; i < CONNECTOR_PENDING_RECEIPT_LIMIT; i++) {
      void before.run(KEY, String(i), 'connector.send', ['hello'], never)
    }
    db.close()

    const reopened = new OrchestrationDb(path)
    const after = new DeliveryReceipts(() => reopened)
    let executed = 0
    const execute = async (): Promise<Delivery> => {
      executed++
      return { outcome: 'accepted' }
    }
    await expect(after.run(KEY, '0', 'connector.send', ['hello'], execute)).resolves.toEqual({
      outcome: 'unknown',
      reason: 'replayed_after_restart'
    })
    expect(
      reopened.getMutationReceipt('connector:dev', JSON.stringify(['thread', '0']))?.state
    ).toBe('completed')
    // The settled rows no longer hold the connector's budget.
    await expect(after.run(KEY, 'new', 'connector.send', ['hello'], execute)).resolves.toEqual({
      outcome: 'accepted'
    })
    expect(executed).toBe(1)
    expect(reopened.countPendingMutationReceipts(['connector:dev'])).toBe(0)
    reopened.close()
  })

  it('leaves other callers’ pending receipts alone', async () => {
    const { db } = fileDb()
    db.beginMutationReceipt(ORDINARY)
    await new DeliveryReceipts(() => db).run(KEY, 'd1', 'connector.send', ['hello'], async () => ({
      outcome: 'accepted'
    }))
    expect(db.getMutationReceipt(ORDINARY.callerFingerprint, ORDINARY.requestId)?.state).toBe(
      'pending'
    )
    db.close()
  })
})
