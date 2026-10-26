import { CONNECTOR_LIMITS, ConnectorPollResponseSchema } from '@orca-cloud/connector-contract'
import { afterEach, describe, expect, it } from 'vitest'
import type { CloudDatabase } from '@orca-cloud/cloud-database'
import type { DeliveryBody } from './connector-inbox.js'
import {
  cleanupConnectorHarnesses,
  createConnectorHarness,
  pauseBefore
} from './connector-server-harness.test-fixture.js'

afterEach(cleanupConnectorHarnesses)

const START: DeliveryBody = { kind: 'start', agent: 'claude', placeId: 'pl_1', prompt: 'fix it' }
const SEND: DeliveryBody = { kind: 'send', text: 'and the tests' }

// Fails the first statement starting with `prefix` once armed, as a transient database fault.
function failOnce(database: CloudDatabase, prefix: string) {
  let armed = false
  const wrap = (inner: CloudDatabase): CloudDatabase => ({
    dialect: inner.dialect,
    query: async (sql, params) => {
      if (armed && sql.trimStart().startsWith(prefix)) {
        armed = false
        throw new Error('injected')
      }
      return await inner.query(sql, params)
    },
    transaction: (run) => inner.transaction((transaction) => run(wrap(transaction))),
    lockQuotaScope: (key) => inner.lockQuotaScope(key),
    tryLockScope: (key) => inner.tryLockScope(key),
    tryLockSharedScope: (key) => inner.tryLockSharedScope(key),
    close: () => inner.close()
  })
  return { database: wrap(database), arm: () => (armed = true) }
}

async function setup(
  options: Parameters<typeof createConnectorHarness>[1] = {},
  machineOptions: Parameters<Awaited<ReturnType<typeof createConnectorHarness>>['machine']>[1] = {}
) {
  const harness = await createConnectorHarness({}, options)
  const machine = await harness.machine('user-1', machineOptions)
  expect((await machine.hello()).status).toBe(204)
  const enqueue = (externalId: string, deliveryId: string, body: DeliveryBody) =>
    harness.runtime.queueDelivery({
      thread: {
        externalId,
        teamId: 'T1',
        channelId: 'C1',
        threadTs: externalId,
        ownerUserId: 'U1',
        hostId: machine.hostId,
        placeId: 'pl_1'
      },
      deliveryId,
      body
    })
  const poll = async () => {
    const { status, body } = await machine.poll()
    expect(status).toBe(200)
    return ConnectorPollResponseSchema.parse(body)
  }
  const ids = async () => (await poll()).deliveries.map((delivery) => delivery.deliveryId)
  return { harness, machine, enqueue, poll, ids }
}

describe('connector inbox', () => {
  it('refuses a request without a connector token', async () => {
    const harness = await createConnectorHarness()
    expect((await harness.json('/v1/connector/poll', { v: 1, helloRev: 1 })).status).toBe(401)
  })

  it('names a host by account and machine, whichever token it presents', async () => {
    const { harness, machine, enqueue, ids } = await setup()
    await enqueue('a', 'a1', START)
    const sameMachine = await harness.machine('user-1', { machineId: machine.machineId })
    expect(ConnectorPollResponseSchema.parse((await sameMachine.poll()).body).deliveries).toHaveLength(1)
    const otherAccount = await harness.machine('user-2', { machineId: machine.machineId })
    expect((await otherAccount.poll()).status).toBe(409)
    expect(await ids()).toEqual([])
  })

  it('requires a hello for the revision a poll names', async () => {
    const harness = await createConnectorHarness()
    const machine = await harness.machine()
    expect((await machine.poll()).status).toBe(409)
    await machine.hello(1)
    expect((await machine.poll(2)).status).toBe(409)
    expect((await machine.poll(1)).status).toBe(200)
  })

  it('hands out a queued delivery with its envelope', async () => {
    const { harness, enqueue, poll } = await setup()
    await expect(enqueue('T1:C1:1.0:U1', 'd1', START)).resolves.toBe('queued')
    const reply = await poll()
    expect(reply.holdMs).toBe(0)
    expect(reply.serverNow).toBe(harness.now())
    expect(reply.deliveries).toEqual([
      {
        ...START,
        deliveryId: 'd1',
        seq: 1,
        expiresAt: harness.now() + CONNECTOR_LIMITS.deliveryTtlMs,
        conversation: { source: 'slack', externalId: 'T1:C1:1.0:U1' }
      }
    ])
    await expect(enqueue('T1:C1:1.0:U1', 'd1', START)).resolves.toBe('duplicate')
  })

  it('wakes a held poll as soon as a delivery is queued', async () => {
    const { enqueue, poll } = await setup({ pollHoldMs: 10_000 })
    const held = poll()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const startedAt = Date.now()
    await enqueue('T1:C1:1.0:U1', 'd1', START)
    expect((await held).deliveries.map((delivery) => delivery.deliveryId)).toEqual(['d1'])
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it('sends one delivery per conversation until it is received', async () => {
    const { machine, enqueue, ids } = await setup()
    await enqueue('a', 'a1', START)
    await enqueue('a', 'a2', SEND)
    await enqueue('b', 'b1', START)
    expect(await ids()).toEqual(['a1', 'b1'])
    expect(await ids()).toEqual([])
    await machine.ack([{ deliveryId: 'a1', step: 'received' }])
    expect(await ids()).toEqual(['a2'])
  })

  it('resends a delivery with the same id once its lease runs out unreceived', async () => {
    const { harness, enqueue, ids } = await setup()
    await enqueue('a', 'a1', START)
    expect(await ids()).toEqual(['a1'])
    harness.advance(CONNECTOR_LIMITS.leaseMs - 1)
    expect(await ids()).toEqual([])
    harness.advance(1)
    expect(await ids()).toEqual(['a1'])
  })

  it('lists received-but-not-done deliveries on the first poll after each hello only', async () => {
    const { machine, enqueue, poll } = await setup()
    await enqueue('a', 'a1', START)
    await enqueue('b', 'b1', START)
    await poll()
    await machine.ack([
      { deliveryId: 'a1', step: 'received' },
      { deliveryId: 'b1', step: 'received' },
      { deliveryId: 'b1', step: 'done', result: { outcome: 'accepted' } }
    ])
    expect((await poll()).unsettled).toBeUndefined()

    // The machine restarts: a new hello, then its first poll.
    await machine.hello(2)
    const first = ConnectorPollResponseSchema.parse((await machine.poll(2)).body)
    expect(first.unsettled).toEqual([
      { deliveryId: 'a1', conversation: { source: 'slack', externalId: 'a' } }
    ])
    const second = ConnectorPollResponseSchema.parse((await machine.poll(2)).body)
    expect(second.unsettled).toBeUndefined()
  })

  // SQLite runs one transaction at a time, so only Postgres can interleave the sweep with a claim.
  it.skipIf(!process.env.ORCA_CONNECTOR_TEST_DATABASE_URL)(
    'keeps an expiry that lands while a resend is being claimed',
    async () => {
      let gate!: ReturnType<typeof pauseBefore>
      const { harness, enqueue, poll } = await setup({
        wrapDatabase: (database) => {
          gate = pauseBefore(database, "UPDATE connector_inbox SET state = 'leased'", 1)
          return gate.database
        }
      })
      await enqueue('a', 'a1', START)
      await poll()
      harness.advance(CONNECTOR_LIMITS.leaseMs)
      const resend = poll()
      await gate.atStatement
      // The sweep takes no host lock, so it can expire the row between the claim's read and write.
      harness.advance(CONNECTOR_LIMITS.deliveryTtlMs)
      expect(await harness.runtime.inbox.expireDue()).toHaveLength(1)
      gate.release()
      expect((await resend).deliveries).toEqual([])
      const [row] = await harness.database.query(
        "SELECT state FROM connector_inbox WHERE delivery_id = 'a1'"
      )
      expect(row?.state).toBe('expired')
    }
  )

  it('keeps recovery for the next poll when the first one fails', async () => {
    let fault!: ReturnType<typeof failOnce>
    const { machine, enqueue, poll } = await setup({
      wrapDatabase: (database) => {
        fault = failOnce(database, 'SELECT delivery_id, external_id, seq')
        return fault.database
      }
    })
    await enqueue('a', 'a1', START)
    await poll()
    await machine.ack([{ deliveryId: 'a1', step: 'received' }])
    await machine.hello(2)
    fault.arm()
    expect((await machine.poll(2)).status).toBe(500)
    const retry = ConnectorPollResponseSchema.parse((await machine.poll(2)).body)
    expect(retry.unsettled).toEqual([
      { deliveryId: 'a1', conversation: { source: 'slack', externalId: 'a' } }
    ])
  })

  it('sends a poll held across a newer hello back to hello', async () => {
    const { machine } = await setup({ pollHoldMs: 10_000 })
    const held = machine.poll(1)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const startedAt = Date.now()
    expect((await machine.hello(2)).status).toBe(204)
    expect((await held).status).toBe(409)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it('ignores acks from an older hello and asks for an unrecorded one', async () => {
    const { harness, machine, enqueue, poll } = await setup()
    await enqueue('a', 'a1', START)
    await poll()
    expect((await machine.ack([{ deliveryId: 'a1', step: 'received' }], 2)).status).toBe(409)
    await machine.hello(2)
    expect((await machine.ack([{ deliveryId: 'a1', step: 'received' }], 1)).status).toBe(204)
    const [row] = await harness.database.query(
      "SELECT state FROM connector_inbox WHERE delivery_id = 'a1'"
    )
    expect(row?.state).toBe('leased')
  })

  // SQLite runs one transaction at a time, so only Postgres can race an ack with a hello.
  it.skipIf(!process.env.ORCA_CONNECTOR_TEST_DATABASE_URL)(
    'ignores an ack from the old hello that waited on a newer hello; the lease resends it',
    async () => {
      let gate!: ReturnType<typeof pauseBefore>
      const { harness, machine, enqueue, poll } = await setup({
        wrapDatabase: (database) => {
          gate = pauseBefore(database, 'INSERT INTO connector_hosts', 1)
          return gate.database
        }
      })
      await enqueue('a', 'a1', START)
      await poll()
      const hello = machine.hello(2)
      await gate.atStatement
      const late = machine.ack([{ deliveryId: 'a1', step: 'received' }], 1)
      await new Promise((resolve) => setTimeout(resolve, 200))
      gate.release()
      expect((await hello).status).toBe(204)
      expect((await late).status).toBe(204)
      harness.advance(CONNECTOR_LIMITS.leaseMs)
      const first = ConnectorPollResponseSchema.parse((await machine.poll(2)).body)
      expect(first.deliveries.map((delivery) => delivery.deliveryId)).toEqual(['a1'])
    }
  )

  // SQLite runs one transaction at a time, so only Postgres can race two hellos.
  it.skipIf(!process.env.ORCA_CONNECTOR_TEST_DATABASE_URL)(
    'keeps the newer hello when an older one waited on it',
    async () => {
      let gate!: ReturnType<typeof pauseBefore>
      const { harness, machine } = await setup({
        wrapDatabase: (database) => {
          gate = pauseBefore(database, 'INSERT INTO connector_hosts', 1)
          return gate.database
        }
      })
      const newer = machine.hello(3)
      await gate.atStatement
      const older = machine.hello(2)
      await new Promise((resolve) => setTimeout(resolve, 200))
      gate.release()
      expect([(await newer).status, (await older).status]).toEqual([204, 204])
      const [host] = await harness.database.query('SELECT hello_rev FROM connector_hosts')
      expect(Number(host?.hello_rev)).toBe(3)
      expect((await machine.poll(3)).status).toBe(200)
    }
  )

  it('keeps the first done', async () => {
    const { harness, machine, enqueue, poll } = await setup()
    await enqueue('a', 'a1', START)
    await poll()
    await machine.ack([{ deliveryId: 'a1', step: 'done', result: { outcome: 'accepted' } }])
    await machine.ack([{ deliveryId: 'a1', step: 'done', result: { outcome: 'unsupported' } }])
    const [row] = await harness.database.query(
      "SELECT state, result, payload FROM connector_inbox WHERE delivery_id = 'a1'"
    )
    expect(row).toEqual({ state: 'done', result: '{"outcome":"accepted"}', payload: null })
  })

  it('drops a start the machine never received when it is cancelled', async () => {
    const { enqueue, ids } = await setup()
    await enqueue('a', 'a1', START)
    await enqueue('a', 'a2', SEND)
    await expect(enqueue('a', 'a3', { kind: 'cancel' })).resolves.toBe('dropped')
    await expect(enqueue('a', 'a3', { kind: 'cancel' })).resolves.toBe('duplicate')
    expect(await ids()).toEqual([])
  })

  it('lets a cancel skip the queue once its start is received', async () => {
    const { machine, enqueue, ids } = await setup()
    await enqueue('a', 'a1', START)
    expect(await ids()).toEqual(['a1'])
    await machine.ack([{ deliveryId: 'a1', step: 'received' }])
    await enqueue('a', 'a2', SEND)
    expect(await ids()).toEqual(['a2'])
    await enqueue('a', 'a3', SEND)
    await expect(enqueue('a', 'a4', { kind: 'cancel' })).resolves.toBe('queued')
    expect(await ids()).toEqual(['a4'])
  })

  it('still lets a cancel skip the queue after its settled start is pruned', async () => {
    const { harness, machine, enqueue, ids } = await setup()
    await enqueue('a', 'a1', START)
    await ids()
    await machine.ack([{ deliveryId: 'a1', step: 'done', result: { outcome: 'accepted' } }])
    // What retention leaves of a long conversation: its settled start is gone.
    await harness.database.query("DELETE FROM connector_inbox WHERE delivery_id = 'a1'")
    await enqueue('a', 'a2', SEND)
    expect(await ids()).toEqual(['a2'])
    await enqueue('a', 'a3', { kind: 'cancel' })
    expect(await ids()).toEqual(['a3'])
  })

  it('queues nothing for a machine that never said hello', async () => {
    const { harness, enqueue } = await setup()
    const silent = await harness.machine('user-1')
    await expect(
      harness.runtime.queueDelivery({
        thread: {
          externalId: 'a',
          teamId: 'T1',
          channelId: 'C1',
          threadTs: 'a',
          ownerUserId: 'U1',
          hostId: silent.hostId,
          placeId: 'pl_1'
        },
        deliveryId: 'a1',
        body: START
      })
    ).resolves.toBe('unknown_host')
    await expect(enqueue('b', 'b1', START)).resolves.toBe('queued')
  })

  it('expires pending work at its deadline and leased work 30 s after it', async () => {
    const { harness, enqueue, ids } = await setup()
    await enqueue('a', 'a1', START)
    expect(await ids()).toEqual(['a1'])
    await enqueue('b', 'b1', START)
    harness.advance(CONNECTOR_LIMITS.deliveryTtlMs)
    expect(await harness.runtime.inbox.expireDue()).toEqual([
      { hostId: expect.any(String), externalId: 'b' }
    ])
    expect(await ids()).toEqual([])
    harness.advance(CONNECTOR_LIMITS.leasedExpiryGraceMs)
    expect(await harness.runtime.inbox.expireDue()).toEqual([
      { hostId: expect.any(String), externalId: 'a' }
    ])
  })

  it('accepts a late received for expired work', async () => {
    const { harness, machine, enqueue, ids } = await setup()
    await enqueue('a', 'a1', START)
    await ids()
    harness.advance(CONNECTOR_LIMITS.deliveryTtlMs + CONNECTOR_LIMITS.leasedExpiryGraceMs)
    await harness.runtime.inbox.expireDue()
    expect((await machine.ack([{ deliveryId: 'a1', step: 'received' }])).status).toBe(204)
    const [row] = await harness.database.query(
      "SELECT state FROM connector_inbox WHERE delivery_id = 'a1'"
    )
    expect(row?.state).toBe('received')
  })

  it('ends a held poll by its token expiry', async () => {
    const { machine, poll } = await setup({ pollHoldMs: 10_000 }, { ttlSeconds: 2 })
    const reply = await poll()
    expect(reply.deliveries).toEqual([])
    expect(Date.now()).toBeGreaterThanOrEqual(machine.expiresAt)
    expect(Date.now() - machine.expiresAt).toBeLessThan(1_000)
  })

  it('rolls back a poll pass whose token expired while it ran', async () => {
    let gate!: ReturnType<typeof pauseBefore>
    const { harness, machine, enqueue } = await setup(
      {
        wrapDatabase: (database) => {
          gate = pauseBefore(database, 'SELECT delivery_id, external_id, seq')
          return gate.database
        }
      },
      { ttlSeconds: 2 }
    )
    await enqueue('a', 'a1', START)
    const reply = machine.poll()
    await gate.atStatement
    await new Promise((resolve) => setTimeout(resolve, machine.expiresAt - Date.now() + 10))
    gate.release()
    expect(ConnectorPollResponseSchema.parse((await reply).body).deliveries).toEqual([])
    const [row] = await harness.database.query(
      "SELECT state FROM connector_inbox WHERE delivery_id = 'a1'"
    )
    expect(row?.state).toBe('pending')
    const [host] = await harness.database.query('SELECT unsettled_due FROM connector_hosts')
    expect(Number(host?.unsettled_due)).toBe(1)
  })

  it('wakes a held poll when a lease runs out', async () => {
    const { harness, enqueue, ids, poll } = await setup({ pollHoldMs: 10_000 })
    await enqueue('a', 'a1', START)
    expect(await ids()).toEqual(['a1'])
    harness.advance(CONNECTOR_LIMITS.leaseMs - 100)
    const startedAt = Date.now()
    const held = poll()
    setTimeout(() => harness.advance(100), 50)
    expect((await held).deliveries.map((delivery) => delivery.deliveryId)).toEqual(['a1'])
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it('answers held polls at once with a reconnect when the instance drains', async () => {
    const { harness, machine } = await setup({ pollHoldMs: 10_000 })
    const held = machine.poll()
    await new Promise((resolve) => setTimeout(resolve, 100))
    harness.runtime.waker.drain()
    const reply = ConnectorPollResponseSchema.parse((await held).body)
    expect(reply.control).toEqual({ reconnect: true })
  })
})
