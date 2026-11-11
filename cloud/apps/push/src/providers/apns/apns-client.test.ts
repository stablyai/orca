import { generateKeyPairSync } from 'node:crypto'
import { expect, it } from 'vitest'

import { ApnsClient } from './apns-client.js'
import type { ApnsRequest } from './apns-http2-transport.js'
import type { ApnsResponse } from './apns-stream-response.js'
import type { ApnsCredentials } from '../../config.js'
import { buildPushDelivery } from '../../delivery/push-delivery-message.js'

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
