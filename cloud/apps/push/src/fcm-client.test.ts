import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { fcmCollapseKey, FcmClient, type FcmRequest, type FcmResponse } from './fcm-client.js'
import { buildPushDelivery } from './push-delivery-message.js'

const NOW = 1_700_000_000_000
const HOST = 'abcdefghijklmnop'
const TOKEN = 'cQ1abcDEF_gh:APA91bZZ-zz0123456789abcdefghijklmnopqrstuvwxyz'

function delivery(agentState: 'needs-input' | null = 'needs-input') {
  return buildPushDelivery({
    expiresAt: NOW + 300_000,
    registrationId: 'reg-1',
    hostFingerprint: HOST,
    notification: {
      notificationId: 'note-1',
      notificationSeq: 7,
      notificationEpoch: 'epoch-1',
      source: 'agent-task-complete',
      agentState,
      title: 'Agent needs input',
      body: 'Waiting on your answer',
      worktreeId: 'wt-1'
    }
  })
}

function fakeTransport(response: FcmResponse) {
  const requests: FcmRequest[] = []
  return {
    requests,
    transport: async (request: FcmRequest): Promise<FcmResponse> => {
      requests.push(request)
      return response
    }
  }
}

function client(response: FcmResponse) {
  const fake = fakeTransport(response)
  return {
    fake,
    client: new FcmClient({
      projectId: 'onorca-cloud',
      now: () => NOW,
      accessToken: async () => 'access-token',
      transport: fake.transport
    })
  }
}

describe('fcm client', () => {
  it('posts the v1 send payload for the configured project', async () => {
    const { fake, client: fcm } = client({ status: 200, body: '{"name":"projects/x/messages/1"}' })
    await expect(fcm.send(delivery(), { token: TOKEN })).resolves.toEqual({ status: 'sent' })
    const request = fake.requests[0]!
    expect(request.url).toBe('https://fcm.googleapis.com/v1/projects/onorca-cloud/messages:send')
    expect(request.accessToken).toBe('access-token')
    expect(JSON.parse(request.body)).toEqual({
      message: {
        token: TOKEN,
        notification: { title: 'Agent needs input', body: 'Waiting on your answer' },
        android: {
          priority: 'HIGH',
          ttl: '300s',
          collapse_key: createHash('sha256')
            .update(
              createHash('sha256')
                .update(JSON.stringify([HOST, 'note-1']))
                .digest('hex')
            )
            .digest('hex')
            .slice(0, 32),
          notification: {
            channel_id: 'orca-desktop',
            tag: createHash('sha256')
              .update(JSON.stringify([HOST, 'note-1']))
              .digest('hex')
          }
        },
        data: {
          hostFingerprint: HOST,
          worktreeId: 'wt-1',
          notificationId: 'note-1',
          notificationSeq: '7',
          notificationEpoch: 'epoch-1',
          source: 'agent-task-complete',
          agentState: 'needs-input'
        }
      }
    })
  })

  it('carries every data value as a string and omits a null agent state', async () => {
    const { fake, client: fcm } = client({ status: 200, body: '{}' })
    await fcm.send(delivery(null), { token: TOKEN })
    const message = JSON.parse(fake.requests[0]!.body) as {
      message: {
        android: { collapse_key: string; notification: { tag: string } }
        data: Record<string, string>
      }
    }
    expect(Object.values(message.message.data).every((value) => typeof value === 'string')).toBe(
      true
    )
    expect(message.message.data.agentState).toBeUndefined()
    const tag = createHash('sha256')
      .update(JSON.stringify([HOST, 'note-1']))
      .digest('hex')
    expect(message.message.data.coalescedCount).toBeUndefined()
    expect(message.message.android.notification.tag).toBe(tag)
    expect(message.message.android.collapse_key).toBe(fcmCollapseKey(tag))
    expect(message.message.android.collapse_key).toHaveLength(32)
  })

  it('marks an unregistered token dead from the status or the error detail', async () => {
    const byStatus = client({
      status: 404,
      body: JSON.stringify({ error: { status: 'UNREGISTERED', message: 'not registered' } })
    })
    await expect(byStatus.client.send(delivery(), { token: TOKEN })).resolves.toEqual({
      status: 'dead',
      reason: 'UNREGISTERED'
    })
    const byDetail = client({
      status: 404,
      body: JSON.stringify({
        error: {
          status: 'NOT_FOUND',
          message: 'Requested entity was not found.',
          details: [{ errorCode: 'UNREGISTERED' }]
        }
      })
    })
    await expect(byDetail.client.send(delivery(), { token: TOKEN })).resolves.toEqual({
      status: 'dead',
      reason: 'UNREGISTERED'
    })
  })

  it('marks an invalid-argument that names the token dead, and others an error', async () => {
    const named = client({
      status: 400,
      body: JSON.stringify({
        error: { status: 'INVALID_ARGUMENT', message: 'The registration token is not valid.' }
      })
    })
    await expect(named.client.send(delivery(), { token: TOKEN })).resolves.toEqual({
      status: 'dead',
      reason: 'INVALID_ARGUMENT'
    })
    const unnamed = client({
      status: 400,
      body: JSON.stringify({
        error: { status: 'INVALID_ARGUMENT', message: 'Invalid value at message.android.ttl' }
      })
    })
    await expect(unnamed.client.send(delivery(), { token: TOKEN })).resolves.toEqual({
      status: 'error',
      reason: 'INVALID_ARGUMENT',
      retryable: false,
      retryAfterMs: 10000
    })
  })

  it('treats a server fault and a transport failure as errors', async () => {
    const faulted = client({
      status: 503,
      body: JSON.stringify({ error: { status: 'UNAVAILABLE', message: 'backend busy' } })
    })
    await expect(faulted.client.send(delivery(), { token: TOKEN })).resolves.toEqual({
      status: 'error',
      reason: 'UNAVAILABLE',
      retryable: true,
      retryAfterMs: 10000
    })
    const broken = new FcmClient({
      projectId: 'onorca-cloud',
      now: () => NOW,
      accessToken: async () => 'access-token',
      transport: async () => {
        throw new Error('ECONNRESET')
      }
    })
    await expect(broken.send(delivery(), { token: TOKEN })).resolves.toEqual({
      status: 'error',
      reason: 'Error',
      retryable: true
    })
  })
})

it('does not send when credential refresh crosses the absolute expiry', async () => {
  let now = 1000
  const fake = fakeTransport({ status: 200, body: '{}' })
  const fcm = new FcmClient({
    projectId: 'test',
    now: () => now,
    accessToken: async () => {
      now = 3000
      return 'test-token'
    },
    transport: fake.transport
  })
  await expect(fcm.send({ ...delivery(), expiresAt: 2000 }, { token: TOKEN })).resolves.toEqual({
    status: 'error',
    reason: 'expired'
  })
  expect(fake.requests).toHaveLength(0)
})

it('decreases retry TTL and refuses expired delivery before refreshing credentials', async () => {
  let now = NOW
  let refreshes = 0
  const fake = fakeTransport({ status: 503, body: '{}' })
  const fcm = new FcmClient({
    projectId: 'test',
    now: () => now,
    accessToken: async () => {
      refreshes++
      return 'test-token'
    },
    transport: fake.transport
  })
  const pending = delivery()
  await fcm.send(pending, { token: TOKEN })
  now += 60_000
  await fcm.send(pending, { token: TOKEN })
  expect(fake.requests.map((request) => JSON.parse(request.body).message.android.ttl)).toEqual([
    '300s',
    '240s'
  ])
  now = pending.expiresAt
  await expect(fcm.send(pending, { token: TOKEN })).resolves.toEqual({
    status: 'error',
    reason: 'expired'
  })
  expect(fake.requests).toHaveLength(2)
  expect(refreshes).toBe(2)
})
