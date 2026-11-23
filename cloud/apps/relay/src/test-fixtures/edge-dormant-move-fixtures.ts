// Shared by the edge-move-dormant suites (edge-relay-move-dormant*.test.ts): constants, the
// director config and database wrappers. No mocks here: each suite registers its own.
import { ASSIGNMENT_LIMITS } from '@orca-cloud/relay-contract'
import type { RelayConfig, RelayCellConfig } from '../config.js'
import type { RelayDatabase } from '../database.js'

export const EDGE_URL = 'https://edge.relay.example.test'
export const RETIRING: RelayCellConfig = { id: 'production-gce-c7', url: 'https://c7.relay.example.test', capacityRequests: 1_000 }
export const OTHER: RelayCellConfig = { id: 'production-gce-c8', url: 'https://c8.relay.example.test', capacityRequests: 1_000 }
export const USER = 'user-dormant-1'
export const HOST = 'dormanthost00001'
export const SECOND_HOST = 'dormanthost00002'
export const IDENTITY = { userId: USER, relayHostId: HOST }
export const T0 = 1_000_000_000_000
export const TTL = ASSIGNMENT_LIMITS.dormantTtlMs

export function config(): RelayConfig {
  return {
    port: 8080,
    publicUrl: 'https://relay.example.test',
    cellUrl: 'https://relay.example.test',
    region: 'us-central1',
    authIssuer: 'https://auth.example.test',
    authAudience: 'orca-relay',
    jwksUrl: 'https://auth.example.test/jwks',
    assignmentSigningKey: new TextEncoder().encode('assignment-key-with-at-least-32-bytes'),
    role: 'director',
    cellId: 'director',
    cells: [],
    adminAudience: 'https://relay.example.test/v1/admin/drain',
    deployServiceAccount: 'deploy@example.test',
    runtimeServiceAccount: 'runtime@example.test',
    adminJwksUrl: 'https://auth.example.test/jwks',
    databasePoolMax: 3,
    publicAssignmentsEnabled: true,
    regionalPlacementEnabled: true,
    publicAssignmentConcurrency: 2,
    publicAssignmentQueueMax: 128,
    publicAssignmentWaitMs: 4_000,
    publicResolveConcurrency: 1,
    publicResolveWaitMs: 5_000,
    publicAssignmentRetryAfterSeconds: 5,
    dataDir: './data'
  }
}

// SQLite serializes transactions; run them inline so moves overlap as they do on Postgres.
export function overlapping(database: RelayDatabase): RelayDatabase {
  return new Proxy(database, {
    get(target, property) {
      if (property === 'transaction') {
        return async <T>(operation: (transaction: RelayDatabase) => Promise<T>) => await operation(target)
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

// Lease rows locked elsewhere: every locked lease read inside a transaction answers unavailable.
export function leaseLocksBusy(database: RelayDatabase): RelayDatabase {
  const wrap = (transaction: RelayDatabase): RelayDatabase =>
    new Proxy(transaction, {
      get(target, property) {
        if (property === 'queryLocked') {
          return async (sql: string, ...rest: unknown[]) => {
            if (sql.includes('relay_assignment_activity_leases')) { throw new Error('database_lock_unavailable') }
            return await (target.queryLocked as (...args: unknown[]) => Promise<unknown>)(sql, ...rest)
          }
        }
        const value = Reflect.get(target, property, target) as unknown
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  return new Proxy(database, {
    get(target, property) {
      if (property === 'transaction') {
        return async <T>(operation: (transaction: RelayDatabase) => Promise<T>, ...rest: unknown[]) =>
          await (target.transaction as (...args: unknown[]) => Promise<T>)(
            (transaction: RelayDatabase) => operation(wrap(transaction)),
            ...rest
          )
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

export type ShadowStub = {
  complete: boolean
  seated: Set<string>
  recentlyLeftAt: Map<string, number>
  booking?: { cellId: string; epoch: number; at: number }
  // The source cell's feed: 'fresh' answers a poll sent just now, by the cell's current process.
  feed: 'fresh' | 'pending' | 'stale' | 'mismatch' | 'unverifiable' | 'partial'
  // Called on every seatsOf read: lets a test seat the host part way through a move.
  onSeatsRead?: (reads: number) => void
}

export const INCARNATION = '33333333-3333-4333-8333-333333333333'
