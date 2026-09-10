import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ApnsAuthenticationToken, APNS_TOKEN_ROTATION_MS } from './apns-authentication-token.js'
import { ApnsClient } from './apns-client.js'
import type { ApnsRequest, ApnsResponse } from './apns-http2-transport.js'
import type { ApnsCredentials } from './config.js'
import { buildPushDelivery } from './push-delivery-message.js'

const HOST = 'abcdefghijklmnop'

function credentials(): ApnsCredentials {
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  })
  return { keyPem: privateKey, keyId: 'ABCDE12345', teamId: 'TEAM123456' }
}

function delivery(now = Date.now()) {
  return buildPushDelivery({
    expiresAt: now + 300_000,
    registrationId: 'reg-1',
    hostFingerprint: HOST,
    notification: {
      notificationId: 'note-1',
      notificationSeq: 7,
      notificationEpoch: 'epoch-1',
      source: 'agent-task-complete',
      agentState: 'needs-input',
      title: 'Agent needs input',
      body: 'Waiting on your answer',
      worktreeId: 'wt-1'
    }
  })
}

function fakeTransport(response: ApnsResponse) {
  const requests: ApnsRequest[] = []
  return {
    requests,
    transport: async (request: ApnsRequest): Promise<ApnsResponse> => {
      requests.push(request)
      return response
    }
  }
}

describe('apns authentication token', () => {
  it('signs an ES256 provider token and caches it until the rotation point', () => {
    let clock = 1_700_000_000_000
    const authentication = new ApnsAuthenticationToken(credentials(), () => clock)
    const first = authentication.value()
    const [header, payload, signature] = first.split('.')
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString('utf8'))).toEqual({
      alg: 'ES256',
      kid: 'ABCDE12345'
    })
    expect(JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'))).toEqual({
      iss: 'TEAM123456',
      iat: Math.floor(clock / 1000)
    })
    expect(Buffer.from(signature!, 'base64url').byteLength).toBe(64)

    clock += APNS_TOKEN_ROTATION_MS - 1
    expect(authentication.value()).toBe(first)
    clock += 1
    expect(authentication.value()).not.toBe(first)
  })
})

describe('apns client', () => {
  it('sends the specified headers, path, and alert body', async () => {
    const clock = 1_700_000_000_000
    const fake = fakeTransport({ status: 200, body: '' })
    const client = new ApnsClient({
      topic: 'com.stably.orca.mobile',
      credentials: credentials(),
      transport: fake.transport,
      now: () => clock
    })
    await expect(
      client.send(delivery(clock), { token: 'a'.repeat(64), apnsEnvironment: 'production' })
    ).resolves.toEqual({ status: 'sent' })
    const request = fake.requests[0]!
    expect(request.host).toBe('api.push.apple.com')
    expect(request.path).toBe(`/3/device/${'a'.repeat(64)}`)
    expect(request.headers).toMatchObject({
      'apns-topic': 'com.stably.orca.mobile',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(clock / 1000) + 5 * 60),
      'apns-collapse-id': expect.stringMatching(/^[a-f0-9]{64}$/)
    })
    expect(request.headers.authorization).toMatch(/^bearer /)
    expect(JSON.parse(request.body)).toEqual({
      aps: {
        alert: { title: 'Agent needs input', body: 'Waiting on your answer' },
        sound: 'default',
        'thread-id': HOST
      },
      orca: {
        hostFingerprint: HOST,
        worktreeId: 'wt-1',
        notificationId: 'note-1',
        notificationSeq: 7,
        notificationEpoch: 'epoch-1',
        source: 'agent-task-complete',
        agentState: 'needs-input'
      }
    })
  })

  it('targets the sandbox host and keeps the individual collapse id', async () => {
    const fake = fakeTransport({ status: 200, body: '' })
    const client = new ApnsClient({
      topic: 'com.stably.orca.mobile',
      credentials: credentials(),
      transport: fake.transport
    })
    await client.send(delivery(), { token: 'b'.repeat(64), apnsEnvironment: 'sandbox' })
    expect(fake.requests[0]?.host).toBe('api.sandbox.push.apple.com')
    expect(fake.requests[0]?.headers['apns-collapse-id']).toMatch(/^[a-f0-9]{64}$/)
  })

  it.each([
    [410, 'Unregistered'],
    [400, 'BadDeviceToken'],
    [400, 'Unregistered'],
    [400, 'DeviceTokenNotForTopic']
  ])('classifies %i %s as a dead token', async (status, reason) => {
    const fake = fakeTransport({ status, body: JSON.stringify({ reason }) })
    const client = new ApnsClient({
      topic: 'com.stably.orca.mobile',
      credentials: credentials(),
      transport: fake.transport
    })
    await expect(
      client.send(delivery(), { token: 'a'.repeat(64), apnsEnvironment: 'production' })
    ).resolves.toEqual({ status: 'dead', reason })
  })

  it.each([
    [400, 'PayloadTooLarge'],
    [429, 'TooManyRequests'],
    [500, 'InternalServerError']
  ])('treats %i %s with the appropriate retry policy', async (status, reason) => {
    const fake = fakeTransport({ status, body: JSON.stringify({ reason }) })
    const client = new ApnsClient({
      topic: 'com.stably.orca.mobile',
      credentials: credentials(),
      transport: fake.transport
    })
    await expect(
      client.send(delivery(), { token: 'a'.repeat(64), apnsEnvironment: 'production' })
    ).resolves.toEqual({ status: 'error', reason, retryable: status === 429 || status >= 500 })
  })

  it('reports a transport failure as an error rather than throwing', async () => {
    const client = new ApnsClient({
      topic: 'com.stably.orca.mobile',
      credentials: credentials(),
      transport: async () => {
        throw new Error('socket hang up')
      }
    })
    await expect(
      client.send(delivery(), { token: 'a'.repeat(64), apnsEnvironment: 'production' })
    ).resolves.toEqual({ status: 'error', reason: 'Error', retryable: true })
  })
})

it('does not collapse background dismissals with visible alerts', async () => {
  const fake = fakeTransport({ status: 200, body: '' })
  const apns = new ApnsClient({
    topic: 'test',
    credentials: credentials(),
    transport: fake.transport
  })
  const alert = delivery()
  await apns.send(
    { ...alert, orca: { ...alert.orca, kind: 'dismiss' } },
    {
      token: 'test',
      apnsEnvironment: 'sandbox'
    }
  )
  expect(fake.requests[0]?.headers).not.toHaveProperty('apns-collapse-id')
  expect(fake.requests[0]?.headers).toMatchObject({
    'apns-push-type': 'background',
    'apns-priority': '5'
  })
  expect(JSON.parse(fake.requests[0]!.body).aps).toEqual({ 'content-available': 1 })
})

it('keeps the absolute deadline across retries and refuses expired delivery', async () => {
  let now = 1_700_000_000_000
  const fake = fakeTransport({ status: 503, body: '{}' })
  const client = new ApnsClient({
    topic: 'test',
    credentials: credentials(),
    now: () => now,
    transport: fake.transport
  })
  const pending = delivery(now)
  const device = { token: 'test', apnsEnvironment: 'sandbox' as const }
  await client.send(pending, device)
  now += 60_000
  await client.send(pending, device)
  expect(fake.requests.map((request) => request.headers['apns-expiration'])).toEqual([
    String(pending.expiresAt / 1000),
    String(pending.expiresAt / 1000)
  ])
  now = pending.expiresAt
  await expect(client.send(pending, device)).resolves.toEqual({
    status: 'error',
    reason: 'expired'
  })
  expect(fake.requests).toHaveLength(2)
})
