import { describe, expect, it } from 'vitest'
import {
  loadRelayConfig,
  RELAY_CELL_CONNECTION_HARD_CAP,
  RELAY_DATABASE_POOL_MAX,
  RELAY_DIRECTOR_DATABASE_POOL_MAX,
  RELAY_MAX_CELL_CAPACITY_REQUESTS,
  RELAY_PUBLIC_RESOLVE_CONCURRENCY,
  RELAY_PUBLIC_RESOLVE_WAIT_MS
} from './config.js'

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
  it('requires distinct dedicated admin identities and accepts omitted values', () => {
    const env = cellEnvironment(4_000)
    expect(loadRelayConfig(env)).toMatchObject({
      capacityServiceAccount: undefined,
      asiaProofServiceAccount: undefined,
      monitorServiceAccount: undefined,
      fenceServiceAccount: undefined
    })
    env.ORCA_RELAY_MONITOR_SERVICE_ACCOUNT = ''
    env.ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT = 'capacity@example.iam.gserviceaccount.com'
    env.ORCA_RELAY_ASIA_PROOF_SERVICE_ACCOUNT = 'proof@example.iam.gserviceaccount.com'
    env.ORCA_RELAY_FENCE_SERVICE_ACCOUNT = 'fence@example.iam.gserviceaccount.com'
    expect(loadRelayConfig(env)).toMatchObject({
      capacityServiceAccount: 'capacity@example.iam.gserviceaccount.com',
      asiaProofServiceAccount: 'proof@example.iam.gserviceaccount.com',
      monitorServiceAccount: undefined,
      fenceServiceAccount: 'fence@example.iam.gserviceaccount.com'
    })
    env.ORCA_RELAY_MONITOR_SERVICE_ACCOUNT = env.ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT
    expect(() => loadRelayConfig(env)).toThrow('relay admin service accounts must be distinct')
    env.ORCA_RELAY_MONITOR_SERVICE_ACCOUNT = undefined
    env.ORCA_RELAY_ASIA_PROOF_SERVICE_ACCOUNT = env.ORCA_RELAY_CAPACITY_SERVICE_ACCOUNT
    expect(() => loadRelayConfig(env)).toThrow('relay admin service accounts must be distinct')
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

  it('accepts a measured capacity above the Cloud Run request ceiling', () => {
    expect(loadRelayConfig(cellEnvironment(4_000)).cells[0]?.capacityRequests).toBe(4_000)
  })

  it('retains a finite process-wide capacity bound', () => {
    expect(() => loadRelayConfig(cellEnvironment(RELAY_MAX_CELL_CAPACITY_REQUESTS + 1))).toThrow()
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

  it('accepts hard-cap metadata in director cell inventory', () => {
    const env = cellEnvironment(4_000)
    env.ORCA_RELAY_ROLE = 'director'
    env.ORCA_RELAY_PUBLIC_URL = 'https://relay.example.com'
    env.ORCA_RELAY_CELL_URL = 'https://relay.example.com'
    env.ORCA_RELAY_CELLS_JSON = JSON.stringify([
      {
        id: 'gce-c7',
        url: 'https://c7.relay.example.com',
        capacityRequests: 4_000,
        connectionHardCap: 1_000,
        connectionUnobservedBound: 60
      }
    ])

    expect(loadRelayConfig(env).cells[0]).toMatchObject({
      connectionHardCap: 1_000,
      connectionUnobservedBound: 60
    })
  })

  it('accepts mixed 600- and 1000-cap director inventory', () => {
    const env = cellEnvironment(4_000)
    env.ORCA_RELAY_ROLE = 'director'
    env.ORCA_RELAY_PUBLIC_URL = 'https://relay.example.com'
    env.ORCA_RELAY_CELL_URL = 'https://relay.example.com'
    env.ORCA_RELAY_CELLS_JSON = JSON.stringify([
      {
        id: 'gce-c1',
        url: 'https://c1.relay.example.com',
        capacityRequests: 4_000,
        connectionHardCap: 600,
        connectionUnobservedBound: 60
      },
      {
        id: 'gce-c2',
        url: 'https://c2.relay.example.com',
        capacityRequests: 4_000,
        connectionHardCap: 1_000,
        connectionUnobservedBound: 60
      }
    ])

    expect(loadRelayConfig(env).cells.map((cell) => cell.connectionHardCap)).toEqual([
      600, 1_000
    ])
  })

  it('accepts only a canonical served image digest', () => {
    const env = cellEnvironment(4_000)
    env.ORCA_RELAY_IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`
    expect(loadRelayConfig(env).imageDigest).toBe(env.ORCA_RELAY_IMAGE_DIGEST)
    env.ORCA_RELAY_IMAGE_DIGEST = 'relay:latest'
    expect(() => loadRelayConfig(env)).toThrow()
  })

  it('accepts a statically declared candidate that starts disabled', () => {
    const env = cellEnvironment(4_000)
    env.ORCA_RELAY_ROLE = 'director'
    env.ORCA_RELAY_PUBLIC_URL = 'https://relay.example.com'
    env.ORCA_RELAY_CELL_URL = 'https://relay.example.com'
    env.ORCA_RELAY_CELLS_JSON = JSON.stringify([
      {
        id: 'gce-candidate',
        url: 'https://candidate.relay.example.com',
        capacityRequests: 4_000,
        region: 'us-central1',
        initiallyEnabled: false
      }
    ])
    expect(loadRelayConfig(env).cells).toEqual([
      {
        id: 'gce-candidate',
        url: 'https://candidate.relay.example.com',
        capacityRequests: 4_000,
        region: 'us-central1',
        initiallyEnabled: false
      }
    ])
  })

  it('reserves a smaller PostgreSQL connection budget for directors', () => {
    const cellEnv = cellEnvironment(4_000)
    expect(loadRelayConfig(cellEnv).databasePoolMax).toBe(RELAY_DATABASE_POOL_MAX)

    const directorEnv: NodeJS.ProcessEnv = { ...cellEnv, ORCA_RELAY_ROLE: 'director' }
    directorEnv.ORCA_RELAY_CELLS_JSON = JSON.stringify([
      {
        id: 'gce-c1',
        url: 'https://c1.relay.example.com',
        capacityRequests: 4_000
      }
    ])
    expect(loadRelayConfig(directorEnv).databasePoolMax).toBe(RELAY_DIRECTOR_DATABASE_POOL_MAX)

    directorEnv.ORCA_RELAY_DATABASE_POOL_MAX = '7'
    expect(loadRelayConfig(directorEnv).databasePoolMax).toBe(7)
  })

  it('defaults to bounded public assignment admission and supports an emergency stop', () => {
    const env = cellEnvironment(4_000)
    expect(loadRelayConfig(env)).toMatchObject({
      publicAssignmentsEnabled: true,
      regionalPlacementEnabled: true,
      publicAssignmentConcurrency: 2,
      publicAssignmentQueueMax: 128,
      publicAssignmentWaitMs: 4_000,
      publicResolveConcurrency: RELAY_PUBLIC_RESOLVE_CONCURRENCY,
      publicResolveWaitMs: RELAY_PUBLIC_RESOLVE_WAIT_MS,
      publicAssignmentRetryAfterSeconds: 5
    })

    env.ORCA_RELAY_PUBLIC_ASSIGNMENTS_ENABLED = 'false'
    env.ORCA_RELAY_REGIONAL_PLACEMENT_ENABLED = 'false'
    env.ORCA_RELAY_PUBLIC_ASSIGNMENT_CONCURRENCY = '4'
    env.ORCA_RELAY_PUBLIC_ASSIGNMENT_QUEUE_MAX = '256'
    env.ORCA_RELAY_PUBLIC_ASSIGNMENT_WAIT_MS = '8000'
    env.ORCA_RELAY_PUBLIC_ASSIGNMENT_RETRY_AFTER_SECONDS = '30'
    expect(loadRelayConfig(env)).toMatchObject({
      publicAssignmentsEnabled: false,
      regionalPlacementEnabled: false,
      publicAssignmentConcurrency: 4,
      publicAssignmentQueueMax: 256,
      publicAssignmentWaitMs: 8_000,
      publicResolveConcurrency: RELAY_PUBLIC_RESOLVE_CONCURRENCY,
      publicResolveWaitMs: RELAY_PUBLIC_RESOLVE_WAIT_MS,
      publicAssignmentRetryAfterSeconds: 30
    })
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
