// Edge cohort membership, move errors, epoch floor and the relay_devices row mapping shared by
// the director's edge moves (edge-relay.ts).
import { createHash } from 'node:crypto'
import { RELAY_DEFAULT_REGION, type RelayRegion } from '@orca-cloud/relay-contract/relay-regions'
import type { SqlRow } from './database/database.js'
import { z } from 'zod'
import type { EdgeDeviceRow } from './edge-admin-client.js'

export type EdgeRelayConfig = {
  cellUrl: string
  // Present: phase 2 (host data in the edge's objects); director → edge admin calls use it.
  adminSigningKey?: Uint8Array
  // Share of hosts (by hash of relayHostId) in the edge cohort, 0-100.
  rolloutPercent: number
  allowHosts: ReadonlySet<string>
  // Accounts (relay token `sub`) whose hosts all join, e.g. the team's own accounts.
  allowUsers?: ReadonlySet<string>
  denyHosts: ReadonlySet<string>
  // Regions whose hosts may join the cohort, by the region the host asked for.
  regions: ReadonlySet<RelayRegion>
}

export function edgeCohortBucket(relayHostId: string): number {
  return createHash('sha256').update(`edge-cohort:${relayHostId}`).digest().readUInt32BE(0) % 100
}

// Deny wins, then allow (host or account), then region scope and the rollout share.
export function inEdgeCohort(
  config: EdgeRelayConfig,
  relayHostId: string,
  region: RelayRegion | undefined,
  userId?: string
): boolean {
  if (config.denyHosts.has(relayHostId)) { return false }
  if (config.allowHosts.has(relayHostId)) { return true }
  if (userId !== undefined && config.allowUsers?.has(userId)) { return true }
  if (!config.regions.has(region ?? RELAY_DEFAULT_REGION)) { return false }
  return edgeCohortBucket(relayHostId) < config.rolloutPercent
}

// Another director holds the host's row, or the host is on the edge and cannot leave yet (its
// desktop is still connected there): retry shortly.
export class EdgeMoveBusyError extends Error {
  constructor() {
    super('relay_edge_move_busy')
  }
}

export const EDGE_MOVE_BUSY_RETRY_AFTER_SECONDS = 2

// The move cannot happen on this ask (old-cell units still held, or the edge did not take the
// push) and nothing changed: the host stays where it is and moves on a later ask.
export class EdgeMoveDeferredError extends Error {
  constructor(reason: 'units_held' | 'push_failed') {
    super(`relay_edge_move_deferred:${reason}`)
  }
}

export type Identity = { userId: string; relayHostId: string }

type EpochSource = {
  seatsOf(userId: string, relayHostId: string): { epoch: number }[]
  recentlyLeftOf(userId: string, relayHostId: string, now: number): { epoch: number }[]
  bookingOf(userId: string, relayHostId: string): { epoch: number } | undefined
}

// Highest epoch the director's seat map knows for the host, so an edge epoch is minted above every
// epoch a reserve cell or a phone may already hold.
export function mapEpochFloor(source: EpochSource | undefined, identity: Identity, now: number): number {
  if (!source) { return 0 }
  const known = [
    ...source.seatsOf(identity.userId, identity.relayHostId).map((seat) => seat.epoch),
    ...source.recentlyLeftOf(identity.userId, identity.relayHostId, now).map((entry) => entry.epoch),
    source.bookingOf(identity.userId, identity.relayHostId)?.epoch ?? 0
  ]
  return Math.max(0, ...known)
}

export const DEVICE_COLUMNS = [
  'user_id',
  'relay_host_id',
  'relay_device_id',
  'current_hash',
  'current_version',
  'current_expires_at',
  'grace_hash',
  'grace_version',
  'grace_expires_at',
  'revoked_at',
  'updated_at'
] as const
const NUMERIC_DEVICE_COLUMNS = new Set([
  'current_version',
  'current_expires_at',
  'grace_version',
  'grace_expires_at',
  'revoked_at',
  'updated_at'
])
const millis = z.number().int().nonnegative()
export const ExportedDeviceSchema = z
  .object({
    user_id: z.string().min(1),
    relay_host_id: z.string(),
    relay_device_id: z.string().min(1).max(128),
    current_hash: z.string().min(1).max(256),
    current_version: millis,
    current_expires_at: millis,
    grace_hash: z.string().min(1).max(256).nullable(),
    grace_version: millis.nullable(),
    grace_expires_at: millis.nullable(),
    revoked_at: millis.nullable(),
    updated_at: millis
  })
  .strict()

export function requestUnits(row: SqlRow): number {
  return (
    integer(row, 'reserved_controls') +
    2 * integer(row, 'reserved_splices') +
    integer(row, 'reserved_invites') +
    integer(row, 'pending_installs') +
    integer(row, 'pending_confirmations') +
    integer(row, 'migration_leases')
  )
}

export function deviceRow(row: SqlRow): EdgeDeviceRow {
  const out: Record<string, unknown> = {}
  for (const column of DEVICE_COLUMNS) {
    const value = row[column]
    out[column] =
      value === null || value === undefined
        ? null
        : NUMERIC_DEVICE_COLUMNS.has(column)
          ? integer(row, column)
          : value
  }
  return out as EdgeDeviceRow
}

export function integer(row: SqlRow, field: string): number {
  const value = Number(row[field])
  if (!Number.isSafeInteger(value)) { throw new Error(`invalid_${field}`) }
  return value
}

export function text(row: SqlRow, field: string): string {
  const value = row[field]
  if (typeof value !== 'string') { throw new Error(`invalid_${field}`) }
  return value
}