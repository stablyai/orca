import { generateKeyPairSync } from 'node:crypto'
import { PUSH_LIMITS } from '@orca-cloud/push-contract'
import { expect } from 'vitest'
import type { ApnsRequest, ApnsResponse } from './apns-http2-transport.js'
import type { PushConfig } from './config.js'
import type { FcmRequest, FcmResponse } from './fcm-client.js'
import {
  answerPushHostChallenge,
  hostPublicKeyB64,
  type PushHostKeypair
} from './host-challenge-answering.test-fixture.js'
import { openInMemoryPushDatabase, type PushDatabase } from './push-database.js'
import { createPushServer } from './push-server.js'

export const GATEWAY_ORIGIN = 'https://push.onorca.dev'
export const APNS_TOKEN = 'a'.repeat(64)
export const FCM_TOKEN = 'cQ1abcDEF_gh:APA91bZZ-zz0123456789abcdefghijklmnopqrstuvwxyz'
export const FILTER = { sources: ['agent-task-complete'], agentStates: ['needs-input'] }

export function notification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    notificationId: 'note-1',
    notificationSeq: 1,
    notificationEpoch: 'epoch-1',
    source: 'agent-task-complete',
    agentState: 'needs-input',
    title: 'Agent needs input',
    body: 'Waiting on your answer',
    worktreeId: 'wt-1',
    ...overrides
  }
}

export function testPushConfig(): PushConfig {
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  })
  return {
    port: 0,
    publicUrl: GATEWAY_ORIGIN,
    dataDir: './data/push-test',
    databasePoolMax: 10,
    apns: { keyPem: privateKey, keyId: 'ABCDE12345', teamId: 'TEAM123456' },
    apnsTopic: 'com.stably.orca.mobile',
    fcmProjectId: 'onorca-cloud',
    coalesceMs: PUSH_LIMITS.coalesceWindowMs,
    trustedProxyHops: 0
  }
}

type ChallengeWire = {
  challengeId: string
  gatewayEphemeralPublicKeyB64: string
  nonceB64: string
  ciphertextB64: string
  expiresAt: number
}

export async function createPushServerHarness() {
  const database: PushDatabase = await openInMemoryPushDatabase()
  let clock = 1_700_000_000_000
  const apnsRequests: ApnsRequest[] = []
  const fcmRequests: FcmRequest[] = []
  let apnsResponse: ApnsResponse = { status: 200, body: '' }
  let fcmResponse: FcmResponse = { status: 200, body: '{}' }
  const server = createPushServer(testPushConfig(), database, {
    now: () => clock,
    apnsTransport: async (request) => {
      apnsRequests.push(request)
      return apnsResponse
    },
    fcmTransport: async (request) => {
      fcmRequests.push(request)
      return fcmResponse
    },
    fcmAccessToken: async () => 'access-token',
    // Windows are flushed explicitly so the 3s timer never gates a test.
    setTimer: () => ({ handle: null }),
    clearTimer: () => undefined
  })

  const post = async (path: string, body: unknown, token?: string): Promise<Response> =>
    await server.app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body)
    })

  const issueChallenge = async (keypair: PushHostKeypair): Promise<ChallengeWire> => {
    const response = await post('/v1/host/challenge', {
      v: 1,
      hostPublicKeyB64: hostPublicKeyB64(keypair)
    })
    expect(response.status).toBe(200)
    return (await response.json()) as ChallengeWire
  }

  const answer = (challenge: ChallengeWire, keypair: PushHostKeypair): string => {
    const proof = answerPushHostChallenge(challenge, {
      gatewayOrigin: GATEWAY_ORIGIN,
      keypair,
      now: () => clock
    })
    expect(proof).not.toBeNull()
    return proof!
  }

  return {
    server,
    database,
    apnsRequests,
    fcmRequests,
    post,
    issueChallenge,
    answer,
    now: () => clock,
    advanceClock: (deltaMs: number): void => {
      clock += deltaMs
    },
    setApnsResponse: (response: ApnsResponse): void => {
      apnsResponse = response
    },
    setFcmResponse: (response: FcmResponse): void => {
      fcmResponse = response
    },
    authorized: async (path: string, init: RequestInit = {}, token?: string): Promise<Response> =>
      await server.app.request(path, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          ...(token ? { authorization: `Bearer ${token}` } : {})
        }
      }),
    signIn: async (keypair: PushHostKeypair): Promise<string> => {
      const challenge = await issueChallenge(keypair)
      const response = await post('/v1/host/session', {
        v: 1,
        challengeId: challenge.challengeId,
        proofB64: answer(challenge, keypair)
      })
      expect(response.status).toBe(200)
      return ((await response.json()) as { sessionToken: string }).sessionToken
    },
    registerAndroid: async (token: string, deviceId = 'device-1'): Promise<string> => {
      const response = await post(
        '/v1/devices',
        { v: 1, deviceId, platform: 'android', token: FCM_TOKEN, filter: FILTER },
        token
      )
      expect(response.status).toBe(200)
      return ((await response.json()) as { registrationId: string }).registrationId
    },
    close: async (): Promise<void> => {
      server.coalescer.stop()
      // A test may close the database itself to provoke a route failure.
      await database.close().catch(() => undefined)
    }
  }
}
