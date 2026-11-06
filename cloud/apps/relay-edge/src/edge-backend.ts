// What the edge needs from the relay database, behind one interface:
// - postgres: the cells' own RelayCredentialStore (cloud/apps/relay/src/credential-store.ts),
//   imported unchanged, over Hyperdrive; plus the two assignment reads the cells make.
// - spike: no database (load tests on workers.dev); stub credentials from env, no epoch check.
//
// The store's background pieces stay off here: cleanup()/HeapWindowReaper is only called by
// directors, and the ResumeConfirmedAuditBuffer timer only starts on memory confirms, which the
// edge does not use (it records connection bases and confirms through the database path). So no
// timer keeps an object awake.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { RELAY_PROTOCOL_LIMITS } from '../../../packages/relay-contract/src/protocol-limits'
import type { DeviceCredentialInstalled, DeviceResumeConfirmed } from '../../../packages/relay-contract/src/index'
import {
  RelayCredentialStore,
  RelayStoreError,
  type CredentialReservation,
  type InstallInput,
  type RelayIdentity
} from '../../relay/src/credential-store'
import { metric } from './metrics'
import { EdgePostgresDatabase, isEdgeDatabaseTransientError } from './edge-database'
import { edgeConfig, type Env } from './env'

export type { CredentialReservation }

export type ResumeLookup =
  | { outcome: 'none' }
  | { outcome: 'refused' }
  | { outcome: 'resume'; reservation: CredentialReservation }

export interface EdgeBackend {
  // Hello: does the assignment row place this host on the edge at this epoch?
  verifyAssignment(userId: string, relayHostId: string, assignmentEpoch: number): Promise<boolean>
  // Missing seat: does the assignment row name another cell (4409) or this one/none (4404)?
  assignedElsewhere(userId: string, relayHostId: string): Promise<boolean>
  lookupResume(relayHostId: string, token: string): Promise<ResumeLookup>
  reserveCredential(relayHostId: string, token: string): Promise<CredentialReservation | null>
  failReservation(reservation: CredentialReservation): Promise<void>
  recordConnectionBasis(
    input: CredentialReservation & { basisConnId: string; owningControlGeneration: number; deadline: number }
  ): Promise<void>
  deactivateBasis(basisConnId: string): Promise<void>
  createInvite(
    identity: RelayIdentity,
    relayDeviceId: string
  ): Promise<{ inviteToken: string; expiresAt: number; maxAttempts: number }>
  recordDirectAuthorization(
    input: RelayIdentity & { relayDeviceId: string; directAuthId: string; owningControlGeneration: number; deadline: number }
  ): Promise<void>
  installCredential(input: InstallInput): Promise<DeviceCredentialInstalled>
  installStatus(input: RelayIdentity & { relayDeviceId: string; reqId: string }): Promise<DeviceCredentialInstalled | null>
  confirmResume(
    input: RelayIdentity & { reqId: string; basisConnId: string; owningControlGeneration: number }
  ): Promise<DeviceResumeConfirmed>
  revoke(identity: RelayIdentity, relayDeviceId: string): Promise<void>
}

class PostgresBackend implements EdgeBackend {
  private readonly database: EdgePostgresDatabase
  private readonly store: RelayCredentialStore

  constructor(connectionString: string, private readonly cellId: string, onOp?: (ms: number, outcome: 'ok' | 'transient' | 'error') => void) {
    this.database = new EdgePostgresDatabase(connectionString, onOp)
    this.store = new RelayCredentialStore(this.database)
  }

  // Same read as AssignmentStore.verifyCellAssignment on a cell (no unassigned bootstrap).
  async verifyAssignment(userId: string, relayHostId: string, assignmentEpoch: number): Promise<boolean> {
    const rows = await this.database.query(
      `SELECT cell_id, assignment_epoch FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
      [userId, relayHostId]
    )
    const row = rows[0]
    return row !== undefined && row.cell_id === this.cellId && Number(row.assignment_epoch) === assignmentEpoch
  }

  async assignedElsewhere(userId: string, relayHostId: string): Promise<boolean> {
    const rows = await this.database.query(
      `SELECT cell_id FROM relay_assignments WHERE user_id = ? AND relay_host_id = ?`,
      [userId, relayHostId]
    )
    return rows[0] !== undefined && rows[0].cell_id !== this.cellId
  }

  lookupResume(relayHostId: string, token: string) {
    return this.store.lookupResume(relayHostId, token)
  }
  reserveCredential(relayHostId: string, token: string) {
    return this.store.reserveCredential(relayHostId, token)
  }
  failReservation(reservation: CredentialReservation) {
    return this.store.failReservation(reservation)
  }
  recordConnectionBasis(
    input: CredentialReservation & { basisConnId: string; owningControlGeneration: number; deadline: number }
  ) {
    return this.store.recordConnectionBasis(input)
  }
  deactivateBasis(basisConnId: string) {
    return this.store.deactivateBasis(basisConnId)
  }
  createInvite(identity: RelayIdentity, relayDeviceId: string) {
    return this.store.createInvite(identity, relayDeviceId)
  }
  recordDirectAuthorization(
    input: RelayIdentity & { relayDeviceId: string; directAuthId: string; owningControlGeneration: number; deadline: number }
  ) {
    return this.store.recordDirectAuthorization(input)
  }
  installCredential(input: InstallInput) {
    return this.store.installCredential(input)
  }
  installStatus(input: RelayIdentity & { relayDeviceId: string; reqId: string }) {
    return this.store.installStatus(input)
  }
  confirmResume(input: RelayIdentity & { reqId: string; basisConnId: string; owningControlGeneration: number }) {
    return this.store.confirmResume(input)
  }
  revoke(identity: RelayIdentity, relayDeviceId: string) {
    return this.store.revoke(identity, relayDeviceId)
  }
}

// Spike/load-test backend: accepts the token hashes configured in env, records nothing.
class SpikeBackend implements EdgeBackend {
  constructor(private readonly env: Env) {}

  async verifyAssignment(): Promise<boolean> {
    return true
  }
  async assignedElsewhere(): Promise<boolean> {
    return false
  }
  async lookupResume(relayHostId: string, token: string): Promise<ResumeLookup> {
    const hash = createHash('sha256').update(token).digest('base64url')
    for (const entry of (this.env.SPIKE_RESUME_TOKEN_HASHES ?? '').split(',')) {
      const [kind, relayDeviceId, expected] = entry.split(':')
      if (!expected || expected.length !== hash.length) continue
      if (!timingSafeEqual(Buffer.from(hash), Buffer.from(expected))) continue
      const now = Date.now()
      return {
        outcome: 'resume',
        reservation: {
          // The spike has no user binding; the host's own control decides who it is.
          userId: '',
          relayHostId,
          relayDeviceId,
          credentialKind: kind === 'invite' ? 'invite' : 'resume',
          tokenHash: hash,
          reservationId: randomUUID(),
          leaseExpiresAt: now + RELAY_PROTOCOL_LIMITS.hostAttachDeadlineMs,
          ...(kind === 'invite'
            ? {}
            : {
                acceptedCredentialVersion: 1,
                acceptedAs: 'current' as const,
                resumeExpiresAt: now + RELAY_PROTOCOL_LIMITS.resumeTtlMs
              })
        }
      }
    }
    return { outcome: 'none' }
  }
  async reserveCredential(): Promise<CredentialReservation | null> {
    return null
  }
  async failReservation(): Promise<void> {}
  async recordConnectionBasis(): Promise<void> {}
  async deactivateBasis(): Promise<void> {}
  private unsupported(): never {
    throw new RelayStoreError('unsupported')
  }
  createInvite(): never {
    return this.unsupported()
  }
  recordDirectAuthorization(): never {
    return this.unsupported()
  }
  installCredential(): never {
    return this.unsupported()
  }
  installStatus(): never {
    return this.unsupported()
  }
  confirmResume(): never {
    return this.unsupported()
  }
  revoke(): never {
    return this.unsupported()
  }
}

export function edgeBackend(env: Env): EdgeBackend {
  const config = edgeConfig(env)
  return config.backend === 'spike'
    ? new SpikeBackend(env)
    : new PostgresBackend(env.HYPERDRIVE!.connectionString, config.cellId, (ms, outcome) => metric(env, 'db_op', ms, outcome))
}

// Control command failures, as the cells report them (host-session-registry controlErrorCode):
// intentional store codes and slugs pass through; anything else could carry the database URL.
export function controlErrorCode(error: unknown): string {
  if (error instanceof RelayStoreError) return error.code
  const message = error instanceof Error ? error.message : ''
  if (/^[a-z0-9_]{1,64}$/.test(message) && message !== 'database_unavailable') return message
  return isEdgeDatabaseTransientError(error) ? 'database_transient' : 'control_operation_failed'
}
