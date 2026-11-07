import { generateKeyPairSync } from 'node:crypto'

import { describe, expect, it } from 'vitest'
import { loadPushConfig } from './config.js'

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


})
