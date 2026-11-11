import { describe, expect, it } from 'vitest'
import { loadRelayConfig } from './config.js'
import { RELAY_CELL_CONNECTION_HARD_CAP } from '@orca-cloud/relay-contract/admission-budgets'
import { RELAY_READINESS_JWKS_GRACE_MS, RELAY_READINESS_SQL_GRACE_MS } from './process-lifecycle/relay-readiness.js'

function cellEnvironment(capacity: number): NodeJS.ProcessEnv {
  return {
    ORCA_RELAY_PUBLIC_URL: 'https://c1.relay.example.com',
    ORCA_RELAY_CELL_URL: 'https://c1.relay.example.com',
    ORCA_RELAY_AUTH_ISSUER: 'https://auth.example.com',
    ORCA_RELAY_JWKS_URL: 'https://auth.example.com/.well-known/jwks.json',
    ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: 'assignment-key-with-at-least-thirty-two-bytes',
    ORCA_RELAY_ROLE: 'cell',
    ORCA_RELAY_CELL_ID: 'gce-c1',
    ORCA_RELAY_CELL_CAPACITY: String(capacity),
    ORCA_RELAY_ADMIN_AUDIENCE: 'https://relay.example.com/v1/admin/drain',
    ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'deploy@example.iam.gserviceaccount.com'
  }
}

describe('GCE relay capacity configuration', () => {

  it('reads an unset readiness grace variable as the default, never as zero', () => {
    const env = cellEnvironment(4_000)
    env.ORCA_RELAY_READINESS_JWKS_GRACE_MS = ''
    env.ORCA_RELAY_READINESS_SQL_GRACE_MS = ''
    expect(loadRelayConfig(env)).toMatchObject({
      readinessJwksGraceMs: RELAY_READINESS_JWKS_GRACE_MS,
      readinessSqlGraceMs: RELAY_READINESS_SQL_GRACE_MS
    })
  })

  it('requires a distinct paired identity and exact audience for regional host drain', () => {
    const env = cellEnvironment(4_000)
    env.ORCA_RELAY_REHOME_DIRECTOR_SERVICE_ACCOUNT =
      'relay-director@example.iam.gserviceaccount.com'
    expect(() => loadRelayConfig(env)).toThrow(
      'relay rehome identity and audience must be configured together'
    )
    env.ORCA_RELAY_REHOME_AUDIENCE = 'https://relay.example.com/v1/admin/host-drain'
    expect(loadRelayConfig(env)).toMatchObject({
      rehomeDirectorServiceAccount: 'relay-director@example.iam.gserviceaccount.com',
      rehomeAudience: 'https://relay.example.com/v1/admin/host-drain'
    })
    env.ORCA_RELAY_REHOME_AUDIENCE = 'https://relay.example.com/v1/admin/drain'
    expect(() => loadRelayConfig(env)).toThrow(
      'relay rehome audience must target the host drain route'
    )
    env.ORCA_RELAY_REHOME_AUDIENCE = 'https://relay.example.com/v1/admin/host-drain'
    env.ORCA_RELAY_RUNTIME_SERVICE_ACCOUNT =
      env.ORCA_RELAY_REHOME_DIRECTOR_SERVICE_ACCOUNT
    expect(() => loadRelayConfig(env)).toThrow(
      'relay rehome director identity must differ from the cell runtime identity'
    )
  })

  it('keeps legacy cells uncapped and requires a supported hard-cap pair', () => {
    const env = cellEnvironment(4_000)
    expect(loadRelayConfig(env)).toMatchObject({
      connectionHardCap: undefined,
      connectionUnobservedBound: undefined
    })

    env.ORCA_RELAY_CELL_CONNECTION_HARD_CAP = String(RELAY_CELL_CONNECTION_HARD_CAP)
    expect(() => loadRelayConfig(env)).toThrow(
      'connection hard cap and unobserved bound must be configured together'
    )
    env.ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND = '60'
    expect(loadRelayConfig(env)).toMatchObject({
      connectionHardCap: 600,
      connectionUnobservedBound: 60
    })
    env.ORCA_RELAY_CELL_CONNECTION_HARD_CAP = '599'
    expect(() => loadRelayConfig(env)).toThrow()
    env.ORCA_RELAY_CELL_CONNECTION_HARD_CAP = '600'
    env.ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND = '500'
    expect(() => loadRelayConfig(env)).toThrow()
    env.ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND = '600'
    expect(() => loadRelayConfig(env)).toThrow()
    env.ORCA_RELAY_CELL_CONNECTION_HARD_CAP = '1000'
    env.ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND = '60'
    expect(loadRelayConfig(env)).toMatchObject({
      connectionHardCap: 1_000,
      connectionUnobservedBound: 60
    })
    env.ORCA_RELAY_CELL_CONNECTION_UNOBSERVED_BOUND = '900'
    expect(() => loadRelayConfig(env)).toThrow()
  })

  it('fails closed when public request lanes exceed the director database pool', () => {
    const env = cellEnvironment(4_000)
    env.ORCA_RELAY_ROLE = 'director'
    env.ORCA_RELAY_CELLS_JSON = JSON.stringify([
      {
        id: 'gce-c1',
        url: 'https://c1.relay.example.com',
        capacityRequests: 4_000
      }
    ])
    env.ORCA_RELAY_DATABASE_POOL_MAX = '2'

    expect(() => loadRelayConfig(env)).toThrow(
      'public relay admission must leave database pool headroom'
    )
  })
})

describe('relay edge configuration', () => {
  function directorEnvironment(): NodeJS.ProcessEnv {
    return {
      ...cellEnvironment(4_000),
      ORCA_RELAY_PUBLIC_URL: 'https://relay.example.com',
      ORCA_RELAY_ROLE: 'director',
      ORCA_RELAY_CELLS_JSON: JSON.stringify([
        { id: 'gce-c1', url: 'https://c1.relay.example.com', capacityRequests: 4_000 }
      ])
    }
  }

  it('is off unless a director names an edge URL, and then defaults to no cohort in us-central1', () => {
    expect(loadRelayConfig(directorEnvironment()).edge).toBeUndefined()
    expect(
      loadRelayConfig({ ...cellEnvironment(4_000), ORCA_RELAY_EDGE_CELL_URL: 'https://edge.relay.example.com' }).edge
    ).toBeUndefined()
    expect(() =>
      loadRelayConfig({ ...directorEnvironment(), ORCA_RELAY_EDGE_CELL_URL: 'https://edge.relay.example.com' })
    ).toThrow('ORCA_RELAY_EDGE_ADMIN_SIGNING_KEY')
    const edge = loadRelayConfig({
      ...directorEnvironment(),
      ORCA_RELAY_EDGE_CELL_URL: 'https://edge.relay.example.com',
      ORCA_RELAY_EDGE_ADMIN_SIGNING_KEY: 'edge-admin-key-with-at-least-32-bytes!!'
    }).edge
    expect(edge).toEqual({
      cellUrl: 'https://edge.relay.example.com',
      adminSigningKey: new TextEncoder().encode('edge-admin-key-with-at-least-32-bytes!!'),
      rolloutPercent: 0,
      allowHosts: new Set(),
      allowUsers: new Set(),
      denyHosts: new Set(),
      regions: new Set(['us-central1'])
    })
  })

  it('parses the cohort and refuses unsafe edge settings', () => {
    const env = {
      ...directorEnvironment(),
      ORCA_RELAY_EDGE_CELL_URL: 'https://edge.relay.example.com',
      ORCA_RELAY_EDGE_ADMIN_SIGNING_KEY: 'edge-admin-key-with-at-least-32-bytes!!',
      ORCA_RELAY_EDGE_ROLLOUT_PERCENT: '10',
      ORCA_RELAY_EDGE_ALLOW_HOSTS: 'abcdefghijklmnop, ABCDEFGHIJKLMNOP',
      ORCA_RELAY_EDGE_DENY_HOSTS: 'zzzzzzzzzzzzzzzz',
      ORCA_RELAY_EDGE_ALLOW_USERS: ' user_01ABC , 6b1f-uuid ',
      ORCA_RELAY_EDGE_REGIONS: 'us-central1,asia-east2'
    }
    expect(loadRelayConfig(env).edge).toMatchObject({
      rolloutPercent: 10,
      allowHosts: new Set(['abcdefghijklmnop', 'ABCDEFGHIJKLMNOP']),
      allowUsers: new Set(['user_01ABC', '6b1f-uuid']),
      denyHosts: new Set(['zzzzzzzzzzzzzzzz']),
      regions: new Set(['us-central1', 'asia-east2'])
    })
    expect(() => loadRelayConfig({ ...env, ORCA_RELAY_EDGE_ROLLOUT_PERCENT: '101' })).toThrow()
    expect(() => loadRelayConfig({ ...env, ORCA_RELAY_EDGE_ALLOW_HOSTS: 'short' })).toThrow()
    expect(() => loadRelayConfig({ ...env, ORCA_RELAY_EDGE_ALLOW_USERS: 'a b' })).toThrow()
    expect(() => loadRelayConfig({ ...env, ORCA_RELAY_EDGE_REGIONS: 'europe-west1' })).toThrow()
    expect(() => loadRelayConfig({ ...env, ORCA_RELAY_EDGE_CELL_URL: 'https://edge.relay.example.com/path' })).toThrow()
    expect(() => loadRelayConfig({ ...env, ORCA_RELAY_EDGE_CELL_URL: 'https://c1.relay.example.com' })).toThrow()
    expect(() => loadRelayConfig({ ...env, ORCA_RELAY_EDGE_CELL_URL: 'https://relay.example.com' })).toThrow()
  })

  it('parses the export skip threshold, leaving the default when unset or empty', () => {
    const env = {
      ...directorEnvironment(),
      ORCA_RELAY_EDGE_CELL_URL: 'https://edge.relay.example.com',
      ORCA_RELAY_EDGE_ADMIN_SIGNING_KEY: 'edge-admin-key-with-at-least-32-bytes!!'
    }
    expect(loadRelayConfig(env).edge).not.toHaveProperty('exportSkipAfterMs')
    expect(loadRelayConfig({ ...env, ORCA_RELAY_EDGE_EXPORT_SKIP_AFTER_MS: '' }).edge).not.toHaveProperty(
      'exportSkipAfterMs'
    )
    expect(loadRelayConfig({ ...env, ORCA_RELAY_EDGE_EXPORT_SKIP_AFTER_MS: '0' }).edge?.exportSkipAfterMs).toBe(0)
    expect(loadRelayConfig({ ...env, ORCA_RELAY_EDGE_EXPORT_SKIP_AFTER_MS: '300000' }).edge?.exportSkipAfterMs).toBe(
      300_000
    )
    expect(() => loadRelayConfig({ ...env, ORCA_RELAY_EDGE_EXPORT_SKIP_AFTER_MS: '-1' })).toThrow()
    expect(() => loadRelayConfig({ ...env, ORCA_RELAY_EDGE_EXPORT_SKIP_AFTER_MS: '1.5' })).toThrow()
    expect(() => loadRelayConfig({ ...env, ORCA_RELAY_EDGE_EXPORT_SKIP_AFTER_MS: 'soon' })).toThrow()
  })
})
