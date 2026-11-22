// Edge cohort membership, move errors, epoch floor and the relay_devices row mapping shared by
// the director's edge moves (edge-relay.ts).
import { createHash } from 'node:crypto'
import { RELAY_DEFAULT_REGION, type RelayRegion } from '@orca-cloud/relay-contract/relay-regions'
import type { SqlRow } from './database/database.js'
import { z } from 'zod'
import type { EdgeDeviceRow } from './edge-admin-client.js'
import { EDGE_CONTROL_DEFAULTS, edgeRolloutPermille, type EdgeControlFlags } from './edge-relay-control.js'

export type EdgeRelayConfig = {
  cellUrl: string
  // Present: phase 2 (host data in the edge's objects); director → edge admin calls use it.
  adminSigningKey?: Uint8Array
  // Share of hosts (by hash of relayHostId) in the edge cohort, 0-100: the boot default, which a
  // runtime rolloutPermille replaces.
  rolloutPercent: number
  // Runtime control (director/edge.json), read on every call; absent means the defaults.
  control?: () => EdgeControlFlags
  allowHosts: ReadonlySet<string>
  // Accounts (relay token `sub`) whose hosts all join, e.g. the team's own accounts.
  allowUsers?: ReadonlySet<string>
  denyHosts: ReadonlySet<string>
  // Regions whose hosts may join the cohort, by the region the host asked for.
  regions: ReadonlySet<RelayRegion>
  // How long the edge's export must keep failing (unavailable) before a leaving host is placed
  // without it; default EDGE_EXPORT_SKIP_AFTER_MS, 0 skips on the first failure.
  exportSkipAfterMs?: number
}

// An edge outage must not strand every leaving host on 503s: after this long of nothing but
// failed exports, a leaving host keeps its Postgres devices and is placed anyway.
export const EDGE_EXPORT_SKIP_AFTER_MS = 120_000
// Export failures further apart than this are not one outage (see EdgeAssignments.leaveEdge).
export const EDGE_EXPORT_FAILURE_GAP_MS = 30_000

function edgeCohortHash(relayHostId: string): number {
  return createHash('sha256').update(`edge-cohort:${relayHostId}`).digest().readUInt32BE(0)
}

export function edgeCohortBucket(relayHostId: string): number {
  return edgeCohortHash(relayHostId) % 100
}

// The percent bucket times ten plus a digit from the hash's higher part, so for every percent P a
// host is under P × 10 permille exactly when it is under P percent: no host moves when the env
// percent becomes the equal permille.
export function edgeCohortBucketPermille(relayHostId: string): number {
  const hash = edgeCohortHash(relayHostId)
  return (hash % 100) * 10 + (Math.floor(hash / 100) % 10)
}

// Mode off or down empties the cohort. Otherwise deny wins, then host allow, then region scope;
// within the region, account allow or the rollout share. Region 'any' skips the region scope.
export function inEdgeCohort(
  config: EdgeRelayConfig,
  relayHostId: string,
  region: RelayRegion | undefined | 'any',
  userId?: string
): boolean {
  const flags = config.control?.() ?? EDGE_CONTROL_DEFAULTS
  if (flags.mode !== 'on') { return false }
  if (config.denyHosts.has(relayHostId)) { return false }
  if (config.allowHosts.has(relayHostId)) { return true }
  if (region !== 'any' && !config.regions.has(region ?? RELAY_DEFAULT_REGION)) { return false }
  if (userId !== undefined && config.allowUsers?.has(userId)) { return true }
  return edgeCohortBucketPermille(relayHostId) < edgeRolloutPermille(config.rolloutPercent, flags)
}

// Whether the host's assignment row may be on the edge, so an ask that is not moving it there must
// read the row (leave) first. A host reaches the edge only through the cohort (its bucket under the
// rollout) or an allow list, and cohorts only grow with the rollout, so a host above the highest
// rollout ever applied (leaveCeilingPermille) never had an edge row. Unset: every host may.
// Mode is ignored: hosts leave under off and down too.
export function mayBeOnEdge(config: EdgeRelayConfig, relayHostId: string, userId?: string): boolean {
  const flags = config.control?.() ?? EDGE_CONTROL_DEFAULTS
  if (flags.leaveCeilingPermille === undefined) { return true }
  if (config.allowHosts.has(relayHostId) || config.denyHosts.has(relayHostId)) { return true }
  if (userId !== undefined && config.allowUsers?.has(userId)) { return true }
  const ceiling = Math.max(
    flags.leaveCeilingPermille,
    edgeRolloutPermille(config.rolloutPercent, flags),
    config.rolloutPercent * 10
  )
  return edgeCohortBucketPermille(relayHostId) < ceiling
}

// Another director holds the host's row, or the host is on the edge and cannot leave yet (its
// desktop is still connected there): retry shortly.
export class EdgeMoveBusyError extends Error {
  constructor() {
    super('relay_edge_move_busy')
  }
}

export const EDGE_MOVE_BUSY_RETRY_AFTER_SECONDS = 2

// Edge admin calls one director may have in flight while it holds assignment row locks (pushes of
// moves). A move that would exceed it is deferred rather than queued behind a slow edge.
export const EDGE_LOCKED_CALLS_MAX = 8

// The move cannot happen on this ask (old-cell units still held, the edge did not take the push, or
// this director already has EDGE_LOCKED_CALLS_MAX pushes in flight) and nothing changed: the host
// stays where it is and moves on a later ask.
export class EdgeMoveDeferredError extends Error {
  constructor(reason: 'units_held' | 'push_failed' | 'edge_busy') {
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