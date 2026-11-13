import { describe, expect, it } from 'vitest'
import { FcmClient, type FcmRequest, type FcmResponse } from './fcm-client.js'
import { buildPushDelivery } from '../../delivery/push-delivery-message.js'

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
      paneKey: 'tab-b:pane-1',
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
    await expect(unnamed.client.send(delivery(), { token: TOKEN })).resolves.toMatchObject({
      status: 'error',
      reason: 'INVALID_ARGUMENT',
      retryable: false
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
