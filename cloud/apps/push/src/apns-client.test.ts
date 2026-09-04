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

function delivery(coalescedCount = 1) {
  return buildPushDelivery({
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
    },
    title: 'Agent needs input',
    body: 'Waiting on your answer',
    coalescedCount
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
      client.send(delivery(), { token: 'a'.repeat(64), apnsEnvironment: 'production' })
    ).resolves.toEqual({ status: 'sent' })
    const request = fake.requests[0]!
    expect(request.host).toBe('api.push.apple.com')
    expect(request.path).toBe(`/3/device/${'a'.repeat(64)}`)
    expect(request.headers).toMatchObject({
      'apns-topic': 'com.stably.orca.mobile',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-expiration': String(Math.floor(clock / 1000) + 4 * 60 * 60),
      'apns-collapse-id': 'note-1'
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
        agentState: 'needs-input',
        coalescedCount: 1
      }
    })
  })

  it('targets the sandbox host and the host collapse id for a summary', async () => {
    const fake = fakeTransport({ status: 200, body: '' })
    const client = new ApnsClient({
      topic: 'com.stably.orca.mobile',
      credentials: credentials(),
      transport: fake.transport
    })
    await client.send(delivery(3), { token: 'b'.repeat(64), apnsEnvironment: 'sandbox' })
    expect(fake.requests[0]?.host).toBe('api.sandbox.push.apple.com')
    expect(fake.requests[0]?.headers['apns-collapse-id']).toBe(`host:${HOST}`)
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
  ])('treats %i %s as a retryable error, not a dead token', async (status, reason) => {
    const fake = fakeTransport({ status, body: JSON.stringify({ reason }) })
    const client = new ApnsClient({
      topic: 'com.stably.orca.mobile',
      credentials: credentials(),
      transport: fake.transport
    })
    await expect(
      client.send(delivery(), { token: 'a'.repeat(64), apnsEnvironment: 'production' })
    ).resolves.toEqual({ status: 'error', reason })
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
    ).resolves.toEqual({ status: 'error', reason: 'Error' })
  })
})
