import { expect } from 'vitest'
import nacl from 'tweetnacl'
import { pushRouteDeclarationContent, type PushNotification } from '@orca-cloud/push-contract'
import type { ApnsRequest, ApnsResponse } from './apns-http2-transport.js'
import { fixture, notification } from './durable-push-store.test-fixture.js'
import { createPushServer } from './push-server.js'
import { GATEWAY_ORIGIN, testPushConfig } from './push-server-harness.test-fixture.js'
import {
  answerPushHostChallenge,
  createPushHostKeypair,
  hostPublicKeyB64
} from './host-challenge-answering.test-fixture.js'
import { deriveHostFingerprint } from './host-fingerprint.js'
import { integer, record, text, ownerCleanup } from './push-owner-integration.test-fixture.js'
import type { PushDatabase, SqlRow } from './push-database.js'
import {
  observeAuthority,
  type AuthorityWork,
  type AuthorityActivity
} from './push-occurrence-observation.test-fixture.js'
export {
  observeAuthority,
  type AuthorityWork,
  type AuthorityActivity
} from './push-occurrence-observation.test-fixture.js'

export const TOKEN = 'ab'.repeat(32)
export const NEXT_TOKEN = 'cd'.repeat(32)
export function required<T>(value: T | undefined | null): T {
  if (value == null) {
    throw new Error('Missing authority fixture value')
  }
  return value
}
export async function authorityFixture(
  options: {
    database?: (db: PushDatabase) => PushDatabase
    provider?: (request: ApnsRequest) => Promise<ApnsResponse>
  } = {}
) {
  const f = await fixture()
  const work: AuthorityWork[] = []
  const locks: string[] = []
  const activity: AuthorityActivity = { transactions: [], advisory: [] }
  const database = observeAuthority(options.database?.(f.db) ?? f.db, work, locks, activity)
  const requests: ApnsRequest[] = []
  const server = createPushServer(testPushConfig(), database, {
    now: f.clock,
    apnsTransport: async (request) => {
      requests.push(request)
      return options.provider ? options.provider(request) : { status: 200, body: '' }
    }
  })
  const post = (path: string, body: unknown, token?: string) =>
    server.app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify(body)
    })
  const key = nacl.sign.keyPair()
  const routeKey = Buffer.from(key.publicKey).toString('base64url')
  const register = async (session: string, token = TOKEN, phoneKey: string | null = routeKey) => {
    const response = await post(
      '/v1/devices',
      {
        v: 1,
        deviceId: 'phone',
        platform: 'ios',
        token,
        apnsEnvironment: 'production',
        ...(phoneKey ? { routeKey: phoneKey } : {})
      },
      session
    )
    expect(response.status).toBe(200)
    return text(record(await response.json()).registrationId)
  }
  const declare = async (hosts: string[], version = 1, signingKey = key, token = TOKEN) => {
    const body = {
      v: 1 as const,
      action: 'replace' as const,
      platform: 'ios' as const,
      apnsEnvironment: 'production' as const,
      token,
      routeKey: Buffer.from(signingKey.publicKey).toString('base64url'),
      version,
      expectedVersion: version === 1 ? null : version - 1,
      hosts
    }
    const response = await post('/v1/routes', {
      ...body,
      signature: Buffer.from(
        nacl.sign.detached(Buffer.from(pushRouteDeclarationContent(body)), signingKey.secretKey)
      ).toString('base64url')
    })
    expect(response.status).toBe(200)
  }
  const send = async (
    sender: { session: string; registrationId: string },
    alert: PushNotification
  ) => {
    const response = await post(
      '/v1/send',
      { v: 1, registrationIds: [sender.registrationId], notification: alert },
      sender.session
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      results: [{ registrationId: sender.registrationId, status: 'queued' }]
    })
  }
  try {
    const actors = []
    for (const seed of [41, 42]) {
      const hostKey = createPushHostKeypair(seed)
      const challengeResponse = await post('/v1/host/challenge', {
        v: 1,
        hostPublicKeyB64: hostPublicKeyB64(hostKey)
      })
      expect(challengeResponse.status).toBe(200)
      const row = record(await challengeResponse.json())
      const proofB64 = answerPushHostChallenge(
        {
          challengeId: text(row.challengeId),
          gatewayEphemeralPublicKeyB64: text(row.gatewayEphemeralPublicKeyB64),
          nonceB64: text(row.nonceB64),
          ciphertextB64: text(row.ciphertextB64),
          expiresAt: integer(row.expiresAt)
        },
        { gatewayOrigin: GATEWAY_ORIGIN, keypair: hostKey, now: f.clock }
      )
      const response = await post('/v1/host/session', {
        v: 1,
        challengeId: row.challengeId,
        proofB64
      })
      expect(response.status).toBe(200)
      const session = text(record(await response.json()).sessionToken)
      actors.push({
        session,
        host: deriveHostFingerprint(hostKey.publicKey),
        registrationId: await register(session)
      })
    }
    const a = required(actors[0])
    const b = required(actors[1])
    await declare([a.host, b.host])
    const alert = (seq = 1): PushNotification => ({
      ...notification(seq),
      notificationId: 'subject',
      origin: b.host,
      occurrence: String(seq).padStart(43, 'o')
    })
    const read = (seq = 2): PushNotification => ({
      ...notification(seq, 'dismiss'),
      notificationId: 'subject'
    })
    return {
      ...f,
      database,
      work,
      locks,
      activity,
      server,
      a,
      b,
      key,
      routeKey,
      register,
      declare,
      send,
      alert,
      read,
      requests,
      device: async (id: string) => required(await server.devices.findById(id)),
      rows: (
        table: 'push_occurrence_domains' | 'push_batch_admissions' | 'push_delivery_batches'
      ): Promise<SqlRow[]> => f.db.query(`SELECT * FROM ${table}`),
      settle: async () => {
        for (let wake = 0; wake < 4; wake++) {
          await server.worker.runDue()
        }
      },
      close: async () => {
        const cleanup = ownerCleanup()
        await cleanup.run(() => server.worker.stop())
        await cleanup.run(() => server.closeTransports())
        cleanup.finish()
      }
    }
  } catch (error) {
    const cleanup = ownerCleanup({ failed: true, error })
    await cleanup.run(() => server.worker.stop())
    await cleanup.run(() => server.closeTransports())
    cleanup.finish()
    throw error
  }
}
