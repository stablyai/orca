import { afterEach, expect, it } from 'vitest'
import { join } from 'node:path'
import { openCloudDatabase } from '@orca-cloud/cloud-database'
import { PushNotificationSchema } from '@orca-cloud/push-contract'
import { openPushDatabase } from './push-database.js'
import { PushDeviceRegistryStore } from './device-registry-store.js'
import { PushDispatcher } from './push-dispatcher.js'
import { DurablePushStore } from './durable-push-store.js'
import { DurablePushWorker } from './durable-push-worker.js'
import { ApnsClient } from './apns-client.js'
import { cleanupDurablePushFixtures } from './durable-push-store.test-fixture.js'
import { archivedGateway, archivedCall } from './push-occurrence-rollout.test-fixture.js'
import { authorityFixture, required, TOKEN } from './push-occurrence-authority.test-fixture.js'
import { record, text, ownerCleanup } from './push-owner-integration.test-fixture.js'
import { testPushConfig } from './push-server-harness.test-fixture.js'
import type { ApnsRequest } from './apns-http2-transport.js'

afterEach(cleanupDurablePushFixtures)

it('runs actual pinned old/new schema, grammar and workers in both directions with legacy payload/collapse bytes', async () => {
  const f = await authorityFixture()
  let old: Awaited<ReturnType<typeof archivedGateway>> | undefined
  const owned: { close(): Promise<void> }[] = []
  const workers: { stop(): Promise<void> }[] = []
  let primary: { failed: true; error: unknown } | undefined
  try {
    old = await archivedGateway()
    const raw = await archivedCall(await old.load('push-schema'), 'pushSchemaStatements')
    if (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string')) {
      throw new Error('Missing archived DDL')
    }
    const schema = raw.map(text)
    expect(schema.join('\n')).not.toContain('push_occurrence')
    const dataDir = join(old.root, 'database')
    const legacyDb = await openCloudDatabase({ service: 'push', dataDir, schemaStatements: schema })
    owned.push(legacyDb)
    const oldDevices = await old.construct('device-registry-store', 'PushDeviceRegistryStore', [
      legacyDb,
      f.clock
    ])
    const registered = record(
      await archivedCall(oldDevices, 'upsert', {
        hostFingerprint: f.a.host,
        deviceId: 'phone',
        platform: 'ios',
        token: TOKEN,
        apnsEnvironment: 'production'
      })
    )
    const registrationId = text(registered.registrationId)
    const oldStore = await old.construct('durable-push-store', 'DurablePushStore', [
      legacyDb,
      f.clock
    ])
    const { origin: _origin, occurrence: _occurrence, ...legacy } = f.alert()
    const oldContract = await old.load('contract/index')
    const oldGrammar = oldContract.PushNotificationSchema
    if (
      !oldGrammar ||
      typeof oldGrammar !== 'object' ||
      !('safeParse' in oldGrammar) ||
      typeof oldGrammar.safeParse !== 'function'
    ) {
      throw new Error('Missing original archived schema parser')
    }
    expect(record(await oldGrammar.safeParse(f.alert())).success).toBe(false)
    expect(record(await oldGrammar.safeParse(legacy)).success).toBe(true)
    expect(PushNotificationSchema.safeParse(legacy).success).toBe(true)
    expect(await archivedCall(oldStore, 'accept', f.a.host, registrationId, legacy)).toBe('queued')
    await legacyDb.close()
    owned.splice(owned.indexOf(legacyDb), 1)
    const db = await openPushDatabase({ dataDir })
    owned.push(db)
    const devices = new PushDeviceRegistryStore(db, f.clock)
    const config = testPushConfig()
    const requests: ApnsRequest[] = []
    const apns = new ApnsClient({
      credentials: required(config.apns),
      topic: config.apnsTopic,
      now: f.clock,
      transport: async (request) => {
        requests.push(request)
        return { status: 200, body: '' }
      }
    })
    const store = new DurablePushStore(db, f.clock)
    const worker = new DurablePushWorker(store, new PushDispatcher({ devices, apns }), {
      now: f.clock
    })
    workers.push(worker)
    await worker.runDue()
    expect(requests).toHaveLength(1)
    expect(record(record(JSON.parse(required(requests[0]).body)).orca)).not.toHaveProperty('origin')
    const input = { ...f.alert(3), notificationId: 'new-to-old' }
    const oldParsed = record(
      await archivedCall(
        await old.load('push-delivery-payload'),
        'parsePushDeliveryPayload',
        JSON.stringify(input)
      )
    )
    expect(oldParsed.origin).toBe(input.origin)
    expect(oldParsed.occurrence).toBe(input.occurrence)
    await store.accept(f.a.host, registrationId, input)
    const reopenedOldDb = await openCloudDatabase({
      service: 'push',
      dataDir,
      schemaStatements: schema
    })
    owned.push(reopenedOldDb)
    const oldStore2 = await old.construct('durable-push-store', 'DurablePushStore', [
      reopenedOldDb,
      f.clock
    ])
    const oldDispatcher = await old.construct('push-dispatcher', 'PushDispatcher', [
      { devices, apns }
    ])
    const oldWorker = await old.construct('durable-push-worker', 'DurablePushWorker', [
      oldStore2.instance,
      oldDispatcher.instance,
      { now: f.clock }
    ])
    workers.push({
      stop: async () => {
        await archivedCall(oldWorker, 'stop')
      }
    })
    await archivedCall(oldWorker, 'runDue')
    expect(requests).toHaveLength(2)
    const sent = record(record(JSON.parse(required(requests[1]).body)).orca)
    expect(sent).not.toHaveProperty('origin')
    expect(sent).not.toHaveProperty('occurrence')
    const oldBuilt = record(
      await archivedCall(await old.load('push-delivery-message'), 'buildPushDelivery', {
        notification: input,
        hostFingerprint: f.a.host,
        registrationId,
        expiresAt: f.clock() + 300_000
      })
    )
    expect(required(requests[1]).headers['apns-collapse-id']).toBe(oldBuilt.collapseId)
    expect(await db.query('SELECT * FROM push_delivery_batches')).toEqual([])
    expect(await db.query('SELECT * FROM push_batch_admissions')).toEqual([])
  } catch (error) {
    primary = { failed: true, error }
  }
  const cleanup = ownerCleanup(primary)
  for (const worker of workers) {
    await cleanup.run(() => worker.stop())
  }
  await cleanup.run(() => f.close())
  for (const db of owned.toReversed()) {
    await cleanup.run(() => db.close())
  }
  await cleanup.run(() => old?.close())
  cleanup.finish()
})

it('loses historical authority immediately on actual old fenced finish and physically prunes its finite orphan', async () => {
  const f = await authorityFixture()
  let old: Awaited<ReturnType<typeof archivedGateway>> | undefined
  let primary: { failed: true; error: unknown } | undefined
  try {
    old = await archivedGateway()
    await f.send(f.a, f.alert())
    const queued = required(await f.server.deliveryStore.claim())
    const admission = f.server.deliveryStore.admission(queued)
    expect(await admission.acquire(await f.device(f.a.registrationId))).toBe('admitted')
    await admission.finalize(false)
    const oldStore = await old.construct('durable-push-store', 'DurablePushStore', [
      f.database,
      f.clock
    ])
    await archivedCall(oldStore, 'finish', queued)
    expect(await f.rows('push_batch_admissions')).toHaveLength(1)
    await f.declare([f.b.host], 2)
    await f.send(f.a, f.read())
    expect(await f.rows('push_occurrence_domains')).toEqual([])
    await f.send(f.b, f.alert())
    await f.settle()
    expect(
      f.requests.filter(
        (request) => record(record(JSON.parse(request.body)).orca).kind !== 'dismiss'
      )
    ).toHaveLength(1)
    expect(await f.rows('push_delivery_batches')).toEqual([])
    f.advance(300_001)
    f.work.length = 0
    await f.server.deliveryStore.prune()
    expect(await f.rows('push_batch_admissions')).toEqual([])
    expect(
      f.work
        .filter((row) => row.sql.startsWith('DELETE FROM push_batch_admissions'))
        .every((row) => row.sql.includes('expires_at <= ? AND NOT EXISTS'))
    ).toBe(true)
    expect(
      f.work.filter((row) => row.sql.startsWith('DELETE FROM push_batch_admissions'))
    ).toHaveLength(1)
  } catch (error) {
    primary = { failed: true, error }
  }
  const cleanup = ownerCleanup(primary)
  await cleanup.run(() => f.close())
  await cleanup.run(() => old?.close())
  cleanup.finish()
})
