import { generateKeyPairSync } from 'node:crypto'
import { PUSH_DEFAULTS } from '@orca-cloud/push-contract'
import { describe, expect, it } from 'vitest'
import { loadPushConfig, PUSH_DATABASE_POOL_MAX } from './config.js'

function apnsKeyPem(): string {
  return generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  }).privateKey
}

const MINIMAL = {
  ORCA_PUSH_PUBLIC_URL: 'https://push.onorca.dev',
  ORCA_PUSH_FCM_PROJECT_ID: 'onorca-cloud'
}

describe('push gateway config', () => {
  it('applies the documented defaults', () => {
    expect(loadPushConfig(MINIMAL)).toEqual({
      mode: 'active',
      port: 8080,
      publicUrl: 'https://push.onorca.dev',
      databaseUrl: undefined,
      dataDir: './data/push',
      databasePoolMax: PUSH_DATABASE_POOL_MAX,
      apns: undefined,
      apnsTopic: PUSH_DEFAULTS.apnsTopic,
      fcmProjectId: 'onorca-cloud',
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
      ORCA_PUSH_TRUSTED_PROXY_HOPS: '1'
    })
    expect(config).toMatchObject({
      port: 9090,
      databaseUrl: 'postgres://localhost/orca_push',
      dataDir: '/var/lib/push',
      apns: { keyPem, keyId: 'ABCDE12345', teamId: 'TEAM123456' },
      apnsTopic: 'com.stably.orca.mobile.dev',
      trustedProxyHops: 1,
      fcmProjectId: 'onorca-staging'
    })
  })

  it('requires an explicit FCM project instead of silently targeting production', () => {
    expect(() => loadPushConfig({ ...MINIMAL, ORCA_PUSH_FCM_PROJECT_ID: undefined })).toThrow()
    expect(() => loadPushConfig({ ...MINIMAL, ORCA_PUSH_FCM_PROJECT_ID: ' ' })).toThrow()
  })

  it('refuses a partial APNs credential', () => {
    expect(() => loadPushConfig({ ...MINIMAL, ORCA_PUSH_APNS_KEY: apnsKeyPem() })).toThrow(
      'configured together'
    )
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
    expect(() =>
      loadPushConfig({ ...MINIMAL, ORCA_PUSH_PUBLIC_URL: 'https://push.onorca.dev/v1' })
    ).toThrow('must be an origin')
    expect(() =>
      loadPushConfig({ ...MINIMAL, ORCA_PUSH_PUBLIC_URL: 'http://push.onorca.dev' })
    ).toThrow('must use HTTPS')
    expect(
      loadPushConfig({ ...MINIMAL, ORCA_PUSH_PUBLIC_URL: 'http://localhost:8080' }).publicUrl
    ).toBe('http://localhost:8080')
  })

  it('treats an empty optional variable as unset', () => {
    expect(
      loadPushConfig({ ...MINIMAL, ORCA_PUSH_DATABASE_URL: '', ORCA_PUSH_APNS_KEY_ID: '' })
    ).toMatchObject({ databaseUrl: undefined, apns: undefined })
  })
})

it('treats blank defaulted environment settings as absent', () => {
  const blanks = Object.fromEntries(
    [
      'PORT',
      'ORCA_PUSH_DATA_DIR',
      'ORCA_PUSH_APNS_TOPIC',
      'ORCA_PUSH_DATABASE_POOL_MAX',
      'ORCA_PUSH_TRUSTED_PROXY_HOPS'
    ].map((key) => [key, ' '])
  )
  expect(loadPushConfig({ ...MINIMAL, ...blanks })).toEqual(loadPushConfig(MINIMAL))
})
