import { LiveActivityBootstrapSchema, LiveActivityContributionSchema } from '@orca-cloud/push-contract/live-activity-messages'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { createPushServerHarness } from './push-server-harness.test-fixture.js'
import { createPushHostKeypair } from '../host-auth/host-challenge-answering.test-fixture.js'
import { LiveActivityOverviewStore } from '../delivery/live-activity-overview-store.js'

const overviewId = '11111111-1111-4111-8111-111111111111'
const firstKey = 'a'.repeat(64)
const aliasKey = 'b'.repeat(64)
const secondKey = 'c'.repeat(64)
const scopeId = (key: string) => createHash('sha256').update(key).digest('hex')
const bootstrap = {
  schemaVersion: 2, overviewId, controlKey: 'd'.repeat(64), revision: 1, showNames: false, discoveryComplete: true,
  token: 'aabb', apnsEnvironment: 'sandbox', scopes: [firstKey, aliasKey, secondKey].map(scopeId)
}
const first = {
  schemaVersion: 2, overviewId, scopeKey: firstKey, sequence: 1, event: 'update',
  content: { counts: { working: 2, attention: 0, done: 0, failed: 0, unavailable: 0 },
    sessions: [{ id: '1'.repeat(32), segment: '1'.repeat(32), title: 'private project', agent: 'codex', state: 'working', elapsedSeconds: 90 }], complete: true }
}
const second = {
  ...first, scopeKey: secondKey,
  content: { counts: { working: 1, attention: 1, done: 0, failed: 0, unavailable: 0 },
    sessions: [{ id: '2'.repeat(32), segment: '2'.repeat(32), title: 'private provider', agent: 'claude', state: 'attention', elapsedSeconds: 20 }], complete: true }
}

it('aggregates durable owner snapshots once, masks names, and expires missing hosts without a new request', async () => {
  const harness = await createPushServerHarness()
  try {
    expect((await harness.post('/v1/live-activities/send', first)).status).toBe(401)
    const hostA = await harness.signIn(createPushHostKeypair(51))
    const hostB = await harness.signIn(createPushHostKeypair(52))
    expect(await (await harness.post('/v1/live-activities/register', bootstrap, hostA)).json()).toEqual({ registered: true })
    await harness.post('/v1/live-activities/send', first, hostA)
    await harness.post('/v1/live-activities/send', { ...first, scopeKey: aliasKey }, hostA)
    await harness.post('/v1/live-activities/send', second, hostB)
    await harness.server.overviewWorker.runDue()
    const wire = harness.apnsRequests[0]!
    const content = JSON.parse(wire.body).aps['content-state']
    expect({ host: wire.host, path: wire.path, topic: wire.headers['apns-topic'], type: wire.headers['apns-push-type'] }).toEqual({
      host: 'api.sandbox.push.apple.com', path: '/3/device/aabb',
      topic: 'com.stably.orca.mobile.push-type.liveactivity', type: 'liveactivity'
    })
    expect(content.counts).toEqual({ working: 3, attention: 1, done: 0, failed: 0, unavailable: 0 })
    expect([content.knownSources, content.totalSources, content.complete, content.state]).toEqual([2, 2, true, 'attention'])
    expect(content.sessions.map((row: { title: string; state: string }) => [row.title, row.state])).toEqual([['', 'attention'], ['', 'working']])
    expect(content.sessions.map((row: { agent?: string }) => row.agent)).toEqual(['claude', 'codex'])
    expect(wire.body).not.toContain('private')
    expect(wire.body).not.toContain(firstKey)
    expect(Buffer.byteLength(wire.body)).toBeLessThan(2800)

    await harness.post('/v1/live-activities/send', { ...second, sequence: 2, content: {
      counts: { working: 0, attention: 0, done: 1, failed: 0, unavailable: 0 }, sessions: [], complete: true
    } }, hostB)
    harness.advanceClock(1000)
    const restored = new LiveActivityOverviewStore(harness.database, harness.now)
    const claim = await restored.claim()
    expect(claim?.push.event).toBe('update')
    expect(claim?.push.content.counts).toEqual({ working: 2, attention: 0, done: 1, failed: 0, unavailable: 0 })
    await restored.finish(claim!, 'sent')
    harness.advanceClock(14 * 60_000)
    await harness.post('/v1/live-activities/send', { ...first, sequence: 2 }, hostA)
    await harness.post('/v1/live-activities/send', second, hostB)
    const heartbeat = await restored.claim()
    await restored.finish(heartbeat!, 'sent')
    harness.advanceClock(59_001)
    const partial = await restored.claim()
    expect(partial?.push.event).toBe('update')
    expect(partial?.push.content.counts).toEqual({ working: 2, attention: 0, done: 0, failed: 0, unavailable: 0 })
    expect([partial?.push.content.knownSources, partial?.push.content.totalSources, partial?.push.content.complete]).toEqual([1, 2, false])
  } finally { await harness.close() }
})

it('fences scope takeover, cohort changes, stale controls and an old in-flight delivery after token rotation', async () => {
  const harness = await createPushServerHarness()
  try {
    const hostA = await harness.signIn(createPushHostKeypair(61))
    const hostB = await harness.signIn(createPushHostKeypair(62))
    await harness.post('/v1/live-activities/register', bootstrap, hostA)
    await harness.post('/v1/live-activities/send', first, hostA)
    expect(await (await harness.post('/v1/live-activities/send', { ...first, sequence: 2 }, hostB)).json()).toEqual({ status: 'error' })
    expect(await (await harness.post('/v1/live-activities/register', { ...bootstrap, controlKey: 'e'.repeat(64), token: 'ccdd', revision: 2 }, hostB)).json()).toEqual({ registered: false })
    expect(await (await harness.post('/v1/live-activities/register', { ...bootstrap, scopes: [scopeId(firstKey)], revision: 2 }, hostA)).json()).toEqual({ registered: false })
    const store = harness.server.liveActivityStore
    const old = await store.claim()
    expect(await new LiveActivityOverviewStore(harness.database, harness.now).claim()).toBeNull()
    expect(await (await harness.post('/v1/live-activities/register', { ...bootstrap, token: 'ccdd', revision: 2 }, hostB)).json()).toEqual({ registered: true })
    await harness.post('/v1/live-activities/register', bootstrap, hostA)
    await store.finish(old!, 'dead')
    harness.advanceClock(1000)
    const current = await store.claim()
    expect(current?.push.token).toBe('ccdd')
    expect(current?.push.event).toBe('update')
    expect(current?.push.timestamp).toBe(1_700_000_001)
    expect(current?.push.content.counts.working).toBe(2)
    await store.finish(current!, 'sent')
  } finally { await harness.close() }
})

it('does not report completion for an empty but incompletely discovered overview', async () => {
  const harness = await createPushServerHarness()
  try {
    const store = new LiveActivityOverviewStore(harness.database, harness.now)
    expect(await store.register('owner', LiveActivityBootstrapSchema.parse({ ...bootstrap,
      scopes: [scopeId(firstKey)], discoveryComplete: false }))).toBe(true)
    await store.contribute('owner', LiveActivityContributionSchema.parse({ ...first, content: {
      counts: { working: 0, attention: 0, done: 0, failed: 0, unavailable: 0 }, sessions: [], complete: true
    } }))
    const claim = await store.claim()
    expect([claim?.push.content.state, claim?.push.content.complete]).toEqual(['unavailable', false])
  } finally { await harness.close() }
})

it('rejects a stale sandbox result after the same token moves to production', async () => {
  const harness = await createPushServerHarness()
  try {
    const store = new LiveActivityOverviewStore(harness.database, harness.now)
    const registration = LiveActivityBootstrapSchema.parse({ ...bootstrap, scopes: [scopeId(firstKey)] })
    await store.register('owner', registration)
    await store.contribute('owner', LiveActivityContributionSchema.parse(first))
    const sandbox = await store.claim()
    expect(sandbox?.push.apnsEnvironment).toBe('sandbox')
    await store.register('owner', { ...registration, revision: 2, apnsEnvironment: 'production' })
    await store.finish(sandbox!, 'dead')
    harness.advanceClock(1000)
    const production = await store.claim()
    expect(production?.push.apnsEnvironment).toBe('production')
    expect(production?.push.token).toBe('aabb')
    expect(production?.push.content.counts.working).toBe(2)
  } finally { await harness.close() }
})
