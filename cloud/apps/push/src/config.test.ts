import { generateKeyPairSync } from 'node:crypto'
import { PUSH_DEFAULTS, PUSH_LIMITS } from '@orca-cloud/push-contract'
import { describe, expect, it } from 'vitest'
import { loadPushConfig, PUSH_DATABASE_POOL_MAX } from './config.js'

function apnsKeyPem(): string {
  return generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  }).privateKey
}

const MINIMAL = { ORCA_PUSH_PUBLIC_URL: 'https://push.onorca.dev' }

describe('push gateway config', () => {
  it('applies the documented defaults', () => {
    expect(loadPushConfig(MINIMAL)).toEqual({
      port: 8080,
      publicUrl: 'https://push.onorca.dev',
      databaseUrl: undefined,
      dataDir: './data/push',
      databasePoolMax: PUSH_DATABASE_POOL_MAX,
      apns: undefined,
      apnsTopic: PUSH_DEFAULTS.apnsTopic,
      fcmProjectId: PUSH_DEFAULTS.fcmProjectId,
      coalesceMs: PUSH_LIMITS.coalesceWindowMs,
      trustedProxyHops: 0
    })
  })

  it('reads a full APNs credential and the overridable knobs', () => {
    const keyPem = apnsKeyPem()
    const config = loadPushConfig({
      ...MINIMAL,
      PORT: '9090',
      ORCA_PUSH_DATABASE_URL: 'postgres://localhost/orca_push',
      ORCA_PUSH_DATA_DIR: '/var/lib/push',
      ORCA_PUSH_APNS_KEY: keyPem,
      ORCA_PUSH_APNS_KEY_ID: 'ABCDE12345',
      ORCA_PUSH_APPLE_TEAM_ID: 'TEAM123456',
      ORCA_PUSH_APNS_TOPIC: 'com.stably.orca.mobile.dev',
      ORCA_PUSH_FCM_PROJECT_ID: 'onorca-staging',
      ORCA_PUSH_COALESCE_MS: '1500',
      ORCA_PUSH_TRUSTED_PROXY_HOPS: '1'
    })
    expect(config).toMatchObject({
      port: 9090,
      databaseUrl: 'postgres://localhost/orca_push',
      dataDir: '/var/lib/push',
      apns: { keyPem, keyId: 'ABCDE12345', teamId: 'TEAM123456' },
      apnsTopic: 'com.stably.orca.mobile.dev',
      trustedProxyHops: 1,
      fcmProjectId: 'onorca-staging',
      coalesceMs: 1500
    })
  })

  it('refuses a partial APNs credential', () => {
    expect(() =>
      loadPushConfig({ ...MINIMAL, ORCA_PUSH_APNS_KEY: apnsKeyPem() })
    ).toThrow('configured together')
    expect(() =>
      loadPushConfig({
        ...MINIMAL,
        ORCA_PUSH_APNS_KEY: 'not-a-pem',
        ORCA_PUSH_APNS_KEY_ID: 'ABCDE12345',
        ORCA_PUSH_APPLE_TEAM_ID: 'TEAM123456'
      })
    ).toThrow('PEM text')
  })

  it('requires a canonical HTTPS origin outside loopback', () => {
    expect(() => loadPushConfig({ ORCA_PUSH_PUBLIC_URL: 'https://push.onorca.dev/v1' })).toThrow(
      'must be an origin'
    )
    expect(() => loadPushConfig({ ORCA_PUSH_PUBLIC_URL: 'http://push.onorca.dev' })).toThrow(
      'must use HTTPS'
    )
    expect(loadPushConfig({ ORCA_PUSH_PUBLIC_URL: 'http://localhost:8080' }).publicUrl).toBe(
      'http://localhost:8080'
    )
  })

  it('treats an empty optional variable as unset', () => {
    expect(
      loadPushConfig({ ...MINIMAL, ORCA_PUSH_DATABASE_URL: '', ORCA_PUSH_APNS_KEY_ID: '' })
    ).toMatchObject({ databaseUrl: undefined, apns: undefined })
  })
})
