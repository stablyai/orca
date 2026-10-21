import { afterEach, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { PushRequestDrain } from './push-request-drain.js'
import { PushDispatcher } from './push-dispatcher.js'
import { PushDeviceRegistryStore } from './device-registry-store.js'
import { openInMemoryPushDatabase, type PushDatabase } from './push-database.js'
import { buildPushDelivery } from './push-delivery-message.js'
import { PushNotificationSchema } from '@orca-cloud/push-contract'
import { notification } from './push-server-harness.test-fixture.js'

const databases: PushDatabase[] = []
afterEach(async () => {
  await Promise.all(databases.splice(0).map((db) => db.close()))
  vi.restoreAllMocks()
})
const note = PushNotificationSchema.parse(notification())
const tick = () => new Promise((resolve) => setImmediate(resolve))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function registered() {
  const db = await openInMemoryPushDatabase()
  databases.push(db)
  const devices = new PushDeviceRegistryStore(db)
  const input = {
    hostFingerprint: 'abcdefghijklmnop',
    deviceId: 'device',
    platform: 'android' as const,
    token: 'old-token'
  }
  const row = await devices.upsert(input)
  if (!row.ok) throw new Error('registration failed')
  const delivery = buildPushDelivery({
    expiresAt: Date.now() + 300_000,
    registrationId: row.registrationId,
    hostFingerprint: input.hostFingerprint,
    notification: note
  })
  return { db, devices, input, delivery }
}

it('does not retire a refreshed token after the old token fails', async () => {
  const h = await registered()
  const gate = deferred()
  const send = vi.fn(async () => {
    await gate.promise
    return { status: 'dead', reason: 'UNREGISTERED' }
  })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const dispatcher = new PushDispatcher({ devices: h.devices, fcm: { send } as never })
  const pending = dispatcher.sendOnce(h.delivery)
  await tick()
  await h.devices.upsert({ ...h.input, token: 'replacement-token' })
  gate.resolve()
  await pending
  expect(await h.devices.findById(h.delivery.registrationId)).toMatchObject({
    token: 'replacement-token',
    dead: false
  })
})

it('rejects new requests during drain and waits for an admitted handler', async () => {
  const gate = deferred()
  const requests = new PushRequestDrain()
  const app = new Hono().use('*', requests.middleware).post('/send', async (c) => {
    await gate.promise
    return c.json({ queued: true })
  })
  const pending = app.request('/send', { method: 'POST' })
  await tick()
  let drained = false
  const drain = requests.begin().then(() => {
    drained = true
  })
  expect((await app.request('/send', { method: 'POST' })).status).toBe(503)
  expect(drained).toBe(false)
  gate.resolve()
  expect((await pending).status).toBe(200)
  await drain
  expect(drained).toBe(true)
})
