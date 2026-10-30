import nacl from 'tweetnacl'
import { afterEach, expect, it } from 'vitest'
import {
  PUSH_LIMITS,
  PushRouteDeclarationSchema,
  PushRouteCurrentSchema,
  pushRouteDeclarationContent
} from '@orca-cloud/push-contract'
import type { PushRouteContent } from '../../../packages/push-contract/src/route-declaration-content.js'
import { createPushServerHarness, APNS_TOKEN } from './push-server-harness.test-fixture.js'
import { createPushHostKeypair } from './host-challenge-answering.test-fixture.js'

let harness: Awaited<ReturnType<typeof createPushServerHarness>> | undefined
afterEach(async () => {
  await harness?.close()
})
async function routes() {
  const h = (harness = await createPushServerHarness())
  const key = nacl.sign.keyPair()
  const identity = {
    v: 1 as const,
    platform: 'ios' as const,
    apnsEnvironment: 'production' as const,
    token: APNS_TOKEN,
    routeKey: Buffer.from(key.publicKey).toString('base64url')
  }
  const sign = (
    operation:
      | { action: 'read' }
      | { action: 'replace'; version: number; expectedVersion: number | null; hosts: string[] }
  ) => {
    const value: PushRouteContent = { ...identity, ...operation }
    return {
      ...value,
      signature: Buffer.from(
        nacl.sign.detached(Buffer.from(pushRouteDeclarationContent(value)), key.secretKey)
      ).toString('base64url')
    }
  }
  const read = () => h.post('/v1/routes', sign({ action: 'read' }))
  const replace = (version: number, expectedVersion: number | null, hosts: string[]) =>
    h.post('/v1/routes', sign({ action: 'replace', version, expectedVersion, hosts }))
  const session = await h.signIn(createPushHostKeypair(90))
  const register = () => h.post('/v1/devices', { ...identity, deviceId: 'phone' }, session)
  return { h, sign, read, replace, register }
}
it('authenticates current q, distinguishes absent/empty, replays before CAS without renewing, and conditionally orders replacements', async () => {
  const f = await routes()
  expect((await f.read()).status).toBe(403)
  expect((await f.register()).status).toBe(200)
  const absent = await f.read()
  expect(absent.headers.get('cache-control')).toBe('no-store')
  expect(await absent.json()).toEqual({ status: 'current', version: null, hosts: [] })
  expect((await f.replace(1, null, ['B'.repeat(16), 'A'.repeat(16), 'A'.repeat(16)])).status).toBe(
    200
  )
  const before = await f.h.database.query('SELECT * FROM push_route_declarations')
  f.h.advanceClock(60_000)
  expect((await f.replace(1, null, ['A'.repeat(16), 'B'.repeat(16)])).status).toBe(200)
  await f.read()
  expect(await f.h.database.query('SELECT * FROM push_route_declarations')).toEqual(before)
  expect((await f.replace(1, 1, ['A'.repeat(16), 'B'.repeat(16)])).status).toBe(200)
  expect((await f.replace(1, 1, ['A'.repeat(16)])).status).toBe(409)
  expect((await f.replace(2, null, [])).status).toBe(409)
  const race = await Promise.all([f.replace(2, 1, []), f.replace(3, 1, ['C'.repeat(16)])])
  expect(race.map((value) => value.status).sort()).toEqual([200, 409])
  const current = PushRouteCurrentSchema.parse(await (await f.read()).json())
  expect(current.version).not.toBeNull()
  expect((await f.replace(4, current.version, [])).status).toBe(200)
  expect(await (await f.read()).json()).toEqual({ status: 'current', version: 4, hosts: [] })
  expect((await f.replace(2, 4, [])).status).toBe(409)
  await f.h.database.query('DELETE FROM push_route_declarations')
  expect(await (await f.read()).json()).toEqual({ status: 'current', version: null, hosts: [] })
  await f.h.database.query('UPDATE push_devices SET dead_at = 1')
  expect((await f.read()).status).toBe(403)
})
it('rejects altered signed action/precondition, raw over-count including duplicates, oversized input, and corrupt rows', async () => {
  const f = await routes()
  await f.register()
  const body = f.sign({ action: 'replace', version: 1, expectedVersion: null, hosts: [] })
  expect((await f.h.post('/v1/routes', { ...body, v: 2 })).status).toBe(400)
  expect((await f.h.post('/v1/routes', { ...body, signature: 'A'.repeat(86) })).status).toBe(401)
  expect((await f.h.post('/v1/routes', { ...body, expectedVersion: 1 })).status).toBe(401)
  expect(
    (
      await f.h.post('/v1/routes', {
        ...f.sign({ action: 'read' }),
        action: 'replace',
        version: 1,
        expectedVersion: null,
        hosts: []
      })
    ).status
  ).toBe(401)
  expect((await f.h.post('/v1/routes', { ...body, extra: true })).status).toBe(400)
  expect(
    (
      await f.replace(
        1,
        null,
        Array.from({ length: 101 }, () => 'A'.repeat(16))
      )
    ).status
  ).toBe(422)
  expect(
    (
      await f.replace(
        1,
        null,
        Array.from({ length: 101 }, (_, i) => String(i).padStart(16, 'A'))
      )
    ).status
  ).toBe(422)
  expect((await f.h.post('/v1/routes', { filler: 'x'.repeat(16_384) })).status).toBe(413)
  expect(await f.h.database.query('SELECT * FROM push_route_declarations')).toEqual([])
  expect((await f.replace(1, null, [])).status).toBe(200)
  await f.h.database.query('UPDATE push_route_declarations SET hosts_json = ?', [
    JSON.stringify(['B'.repeat(16), 'A'.repeat(16)])
  ])
  expect((await f.read()).status).toBe(500)
  expect((await f.replace(2, 1, [])).status).toBe(500)
  await f.h.database.query("UPDATE push_route_declarations SET hosts_json = '[]', version = 0")
  expect((await f.read()).status).toBe(500)
})
it('bounds both operations with the existing unauthenticated IP and destination limiter', async () => {
  const f = await routes()
  f.h.advanceClock(60_000)
  for (let i = 0; i < 30; i++) {
    expect((await (i % 2 ? f.replace(1, null, []) : f.read())).status).toBe(403)
  }
  expect((await f.read()).status).toBe(429)
})
it('encodes and parses the actual maximal signed requests/current reply at shared K', async () => {
  const f = await routes()
  const hosts = Array.from({ length: PUSH_LIMITS.maxRouteHosts }, (_, i) =>
    String(i).padStart(16, 'A')
  ).sort()
  const longToken = 'ab'.repeat(2048)
  const sign = (value: PushRouteContent) => {
    const key = nacl.sign.keyPair()
    const body = { ...value, routeKey: Buffer.from(key.publicKey).toString('base64url') }
    return {
      ...body,
      signature: Buffer.from(
        nacl.sign.detached(Buffer.from(pushRouteDeclarationContent(body)), key.secretKey)
      ).toString('base64url')
    }
  }
  const identity = { ...f.sign({ action: 'read' }), token: longToken }
  const read = sign(identity)
  const replace = sign({
    ...identity,
    action: 'replace',
    version: Number.MAX_SAFE_INTEGER,
    expectedVersion: Number.MAX_SAFE_INTEGER,
    hosts
  })
  expect(Buffer.byteLength(JSON.stringify(read))).toBe(4336)
  expect(Buffer.byteLength(JSON.stringify(replace))).toBe(6311)
  expect(PushRouteDeclarationSchema.safeParse(read).success).toBe(true)
  expect(PushRouteDeclarationSchema.safeParse(replace).success).toBe(true)
  const response = { status: 'current', version: Number.MAX_SAFE_INTEGER, hosts }
  expect(Buffer.byteLength(JSON.stringify(response))).toBe(1957)
  expect(PushRouteCurrentSchema.safeParse(response).success).toBe(true)
})
