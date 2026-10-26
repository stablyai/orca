import { describe, expect, it } from 'vitest'
import { loadConnectorConfig } from './config.js'

const ENV = {
  ORCA_CONNECTOR_PUBLIC_URL: 'https://connector.onorca.dev',
  ORCA_CONNECTOR_AUTH_ISSUER: 'https://login.onorca.dev',
  ORCA_CONNECTOR_JWKS_URL: 'https://login.onorca.dev/.well-known/jwks.json'
}

describe('connector config', () => {
  it('fills defaults around the required settings', () => {
    expect(loadConnectorConfig(ENV)).toEqual({
      mode: 'active',
      port: 8080,
      publicUrl: 'https://connector.onorca.dev',
      dataDir: './data/connector',
      databasePoolMax: 10,
      authIssuer: 'https://login.onorca.dev',
      jwksUrl: 'https://login.onorca.dev/.well-known/jwks.json',
      trustedProxyHops: 0
    })
  })

  it('treats a blank database URL as absent', () => {
    expect(loadConnectorConfig({ ...ENV, ORCA_CONNECTOR_DATABASE_URL: ' ' }).databaseUrl).toBe(
      undefined
    )
  })

  it.each([
    ['a path on the public URL', { ORCA_CONNECTOR_PUBLIC_URL: 'https://connector.onorca.dev/x' }],
    ['plain HTTP off loopback', { ORCA_CONNECTOR_AUTH_ISSUER: 'http://login.onorca.dev' }],
    ['a missing key set URL', { ORCA_CONNECTOR_JWKS_URL: undefined }],
    ['a plain HTTP key set URL', { ORCA_CONNECTOR_JWKS_URL: 'http://login.onorca.dev/jwks' }]
  ])('rejects %s', (_name, override) => {
    expect(() => loadConnectorConfig({ ...ENV, ...override })).toThrow()
  })

  it('allows plain HTTP on loopback for local development', () => {
    expect(
      loadConnectorConfig({ ...ENV, ORCA_CONNECTOR_PUBLIC_URL: 'http://127.0.0.1:8080' }).publicUrl
    ).toBe('http://127.0.0.1:8080')
  })
})
