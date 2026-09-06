import { mkdirSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import {
  emptyPostgresPoolPressureCounts,
  PostgresPoolPressure,
  type PostgresPoolPressureCounts
} from './postgres-pool-pressure.js'
import { applyPostgresSchema } from './postgres-schema-startup.js'
import {
  CellInventoryHoldSamples,
  emptyCellInventoryHoldCounts,
  type CellInventoryHoldCounts
} from './cell-inventory-hold-samples.js'

export const POSTGRES_LOCK_TIMEOUT_MS = 1_000

function setLocalLockTimeout(milliseconds: number): string {
  if (!Number.isInteger(milliseconds) || milliseconds < 1) {
    throw new Error('invalid_lock_timeout')
  }
  return `SET LOCAL lock_timeout = '${milliseconds}ms'`
}

export type SqlRow = Record<string, unknown>
export type RelayLockOptions = {
  failIfUnavailable?: boolean
  // Only honoured inside a transaction: SET LOCAL is a no-op in autocommit.
  lockTimeoutMs?: number
  // Report how long this lock is held to COMMIT. The hold, not the wait, is what
  // forms the queue, and nothing measured it before.
  measureHoldMs?: boolean
}

// A transaction that can report how long it held a measured lock before COMMIT.
type HoldMeasuringTransaction = { consumeHoldMs(): number | undefined }

function measuredHoldMs(transaction: unknown): number | undefined {
  return (transaction as HoldMeasuringTransaction).consumeHoldMs?.()
}
export type RelayTransactionOptions = { reportRetries?: boolean }

export interface RelayDatabase {
  readonly dialect?: 'sqlite' | 'postgres'
  query(sql: string, params?: unknown[]): Promise<SqlRow[]>
  queryLocked(
    sql: string,
    params?: unknown[],
    options?: RelayLockOptions
  ): Promise<SqlRow[]>
  transaction<T>(
    operation: (transaction: RelayDatabase) => Promise<T>,
    options?: RelayTransactionOptions
  ): Promise<T>
  close(): Promise<void>
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS relay_invites (
  user_id TEXT NOT NULL,
  relay_host_id TEXT NOT NULL,
  relay_device_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL,
  attempt_count BIGINT NOT NULL,
  max_attempts BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  reservation_id TEXT,
  reservation_expires_at BIGINT,
  cooldown_until BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, relay_host_id, relay_device_id, token_hash)
);
CREATE INDEX IF NOT EXISTS relay_invites_device
  ON relay_invites(user_id, relay_host_id, relay_device_id);

CREATE TABLE IF NOT EXISTS relay_devices (
  user_id TEXT NOT NULL,
  relay_host_id TEXT NOT NULL,
  relay_device_id TEXT NOT NULL,
  current_hash TEXT NOT NULL,
  current_version BIGINT NOT NULL,
  current_expires_at BIGINT NOT NULL,
  grace_hash TEXT,
  grace_version BIGINT,
  grace_expires_at BIGINT,
  revoked_at BIGINT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, relay_host_id, relay_device_id)
);
CREATE INDEX IF NOT EXISTS relay_devices_current_hash ON relay_devices(relay_host_id, current_hash);
CREATE INDEX IF NOT EXISTS relay_devices_grace_hash ON relay_devices(relay_host_id, grace_hash);

CREATE TABLE IF NOT EXISTS relay_install_results (
  user_id TEXT NOT NULL,
  relay_host_id TEXT NOT NULL,
  relay_device_id TEXT NOT NULL,
  req_id TEXT NOT NULL,
  authorization_mode TEXT NOT NULL,
  result_json TEXT NOT NULL,
  committed_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, relay_host_id, relay_device_id, req_id)
);

CREATE TABLE IF NOT EXISTS relay_confirmable_splices (
  basis_conn_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  relay_host_id TEXT NOT NULL,
  owning_control_generation BIGINT NOT NULL,
  relay_device_id TEXT NOT NULL,
  accepted_credential_version BIGINT NOT NULL,
  accepted_as TEXT NOT NULL,
  confirm_deadline BIGINT NOT NULL,
  active BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_connection_bases (
  basis_conn_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  relay_host_id TEXT NOT NULL,
  relay_device_id TEXT NOT NULL,
  owning_control_generation BIGINT NOT NULL,
  credential_kind TEXT NOT NULL,
  invite_token_hash TEXT,
  accepted_credential_version BIGINT,
  accepted_as TEXT,
  deadline BIGINT NOT NULL,
  active BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);

-- Why: the maintenance sweep matches (active, deadline) while inactive bases
-- accumulate unboundedly. Unindexed it seq-scans millions of rows every cycle
-- and holds the maintenance transaction open long enough to time out
-- assignment lock waits.
CREATE INDEX IF NOT EXISTS relay_connection_bases_active_deadline
  ON relay_connection_bases(active, deadline);

CREATE TABLE IF NOT EXISTS relay_direct_authorizations (
  direct_auth_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  relay_host_id TEXT NOT NULL,
  relay_device_id TEXT NOT NULL,
  owning_control_generation BIGINT NOT NULL,
  deadline BIGINT NOT NULL,
  consumed_at BIGINT
);

CREATE TABLE IF NOT EXISTS relay_confirm_results (
  user_id TEXT NOT NULL,
  relay_host_id TEXT NOT NULL,
  req_id TEXT NOT NULL,
  basis_conn_id TEXT NOT NULL,
  tuple_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  committed_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, relay_host_id, req_id)
);

CREATE TABLE IF NOT EXISTS relay_assignments (
  user_id TEXT NOT NULL,
  relay_host_id TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  assignment_epoch BIGINT NOT NULL,
  lease_expires_at BIGINT NOT NULL,
  last_activity_at BIGINT NOT NULL,
  reserved_controls BIGINT NOT NULL,
  reserved_splices BIGINT NOT NULL,
  reserved_invites BIGINT NOT NULL,
  pending_installs BIGINT NOT NULL,
  pending_confirmations BIGINT NOT NULL,
  migration_leases BIGINT NOT NULL,
  PRIMARY KEY (user_id, relay_host_id)
);

CREATE TABLE IF NOT EXISTS relay_assignment_region_preferences (
  user_id TEXT NOT NULL,
  relay_host_id TEXT NOT NULL,
  preferred_region TEXT NOT NULL
    CHECK (preferred_region IN ('us-central1', 'asia-east2')),
  observed_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, relay_host_id)
);
CREATE INDEX IF NOT EXISTS relay_assignment_region_preferences_observed
  ON relay_assignment_region_preferences(observed_at);

CREATE TABLE IF NOT EXISTS relay_region_rehome_worker_state (
  worker_id TEXT PRIMARY KEY,
  next_dispatch_at BIGINT NOT NULL,
  paused_until BIGINT NOT NULL,
  consecutive_failures BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_region_rehome_control (
  control_id TEXT PRIMARY KEY,
  generation BIGINT NOT NULL,
  enabled BIGINT NOT NULL,
  observation_started_at BIGINT NOT NULL,
  not_before BIGINT NOT NULL,
  rate_per_minute BIGINT NOT NULL,
  preference_max_age_ms BIGINT NOT NULL,
  drain_grace_ms BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_region_rehome_attempts (
  attempt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  relay_host_id TEXT NOT NULL,
  preferred_region TEXT NOT NULL CHECK (preferred_region = 'asia-east2'),
  source_cell_id TEXT NOT NULL,
  source_cell_incarnation TEXT NOT NULL,
  target_cell_id TEXT NOT NULL,
  target_cell_incarnation TEXT NOT NULL,
  previous_epoch BIGINT NOT NULL,
  assignment_epoch BIGINT NOT NULL,
  drain_grace_ms BIGINT NOT NULL,
  send_attempts BIGINT NOT NULL,
  last_send_attempt_at BIGINT,
  drain_receipt_at BIGINT,
  drain_outcome TEXT CHECK (
    drain_outcome IN ('accepted', 'already-accepted', 'host-not-connected')
  ),
  completed_at BIGINT,
  aborted_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (user_id, relay_host_id, assignment_epoch)
);
CREATE INDEX IF NOT EXISTS relay_region_rehome_attempts_pending
  ON relay_region_rehome_attempts(drain_receipt_at, last_send_attempt_at, completed_at, aborted_at);

CREATE TABLE IF NOT EXISTS relay_cells (
  cell_id TEXT PRIMARY KEY,
  cell_url TEXT NOT NULL UNIQUE,
  enabled BIGINT NOT NULL,
  capacity_requests BIGINT NOT NULL,
  reserved_requests BIGINT NOT NULL,
  observed_requests BIGINT NOT NULL,
  last_heartbeat_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_cell_regions (
  cell_id TEXT PRIMARY KEY,
  region TEXT NOT NULL CHECK (region IN ('us-central1', 'asia-east2'))
);

CREATE TABLE IF NOT EXISTS relay_cell_admission (
  cell_id TEXT PRIMARY KEY,
  admission_state TEXT NOT NULL
    CHECK (admission_state IN ('existing-only', 'migration-only', 'general')),
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_admission_selectors (
  selector_id TEXT PRIMARY KEY,
  generation BIGINT NOT NULL,
  attempt_id TEXT,
  membership_json TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_admission_selector_intents (
  attempt_id TEXT PRIMARY KEY,
  expected_generation BIGINT NOT NULL,
  intended_generation BIGINT NOT NULL,
  previous_membership_json TEXT NOT NULL,
  membership_json TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  committed_at BIGINT
);

CREATE TABLE IF NOT EXISTS relay_admission_selector_cell_additions (
  attempt_id TEXT PRIMARY KEY,
  cells_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_cell_runtime (
  cell_id TEXT PRIMARY KEY,
  cell_url TEXT NOT NULL,
  cell_incarnation TEXT NOT NULL,
  started_at BIGINT NOT NULL,
  ready BIGINT NOT NULL,
  observed_requests BIGINT NOT NULL,
  last_heartbeat_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS relay_cell_runtime_heartbeat
  ON relay_cell_runtime(ready, last_heartbeat_at);

CREATE TABLE IF NOT EXISTS relay_cell_capabilities (
  cell_id TEXT PRIMARY KEY,
  cell_incarnation TEXT NOT NULL,
  regional_rehome_protocol BIGINT NOT NULL,
  last_heartbeat_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_cell_rehome_safety (
  cell_id TEXT PRIMARY KEY,
  cell_incarnation TEXT NOT NULL,
  observed_at BIGINT NOT NULL,
  sql_failures BIGINT NOT NULL,
  reconnects BIGINT NOT NULL,
  control_activity_recovery_failures BIGINT NOT NULL,
  database_pool_waiting BIGINT NOT NULL,
  database_pool_waiters_max BIGINT NOT NULL,
  database_pool_wait_ms_max BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_cell_connection_limits (
  cell_id TEXT PRIMARY KEY,
  hard_cap BIGINT NOT NULL,
  unobserved_bound BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_cell_connection_runtime (
  cell_id TEXT PRIMARY KEY,
  cell_incarnation TEXT NOT NULL,
  total_connections BIGINT NOT NULL,
  in_flight_connections BIGINT NOT NULL,
  reserved_connection_units BIGINT NOT NULL,
  enforced_connection_units BIGINT NOT NULL,
  last_heartbeat_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS relay_cell_connection_runtime_heartbeat
  ON relay_cell_connection_runtime(last_heartbeat_at);

CREATE TABLE IF NOT EXISTS relay_cell_connection_snapshots (
  cell_id TEXT PRIMARY KEY,
  cell_incarnation TEXT NOT NULL,
  inclusion_watermark BIGINT NOT NULL,
  total_connections BIGINT NOT NULL,
  in_flight_connections BIGINT NOT NULL,
  reserved_connection_units BIGINT NOT NULL,
  enforced_connection_units BIGINT NOT NULL,
  snapshot_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS relay_cell_connection_snapshot_freshness
  ON relay_cell_connection_snapshots(snapshot_at);

CREATE TABLE IF NOT EXISTS relay_cell_fences (
  cell_id TEXT PRIMARY KEY,
  cell_incarnation TEXT NOT NULL,
  attested_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS relay_cell_fences_expiry
  ON relay_cell_fences(expires_at);

CREATE TABLE IF NOT EXISTS relay_cell_committed_fences (
  cell_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE,
  cell_incarnation TEXT NOT NULL,
  attested_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS relay_cell_committed_fences_expiry
  ON relay_cell_committed_fences(expires_at);

CREATE TABLE IF NOT EXISTS relay_cell_legacy_fence_adoptions (
  cell_id TEXT PRIMARY KEY,
  cell_incarnation TEXT NOT NULL,
  attested_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS relay_cell_legacy_fence_adoptions_expiry
  ON relay_cell_legacy_fence_adoptions(expires_at);

CREATE TABLE IF NOT EXISTS relay_cell_fence_attempts (
  attempt_id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  cell_incarnation TEXT NOT NULL,
  mig_name TEXT NOT NULL,
  instance_group TEXT NOT NULL,
  generation_identity TEXT NOT NULL,
  fence_commit TEXT NOT NULL,
  plan_sha256 TEXT NOT NULL,
  gce_operation TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  apply_started_at BIGINT,
  completed_at BIGINT,
  aborted_at BIGINT
);
CREATE INDEX IF NOT EXISTS relay_cell_fence_attempts_expiry
  ON relay_cell_fence_attempts(expires_at);
CREATE INDEX IF NOT EXISTS relay_cell_fence_attempts_cell
  ON relay_cell_fence_attempts(cell_id, created_at);

CREATE TABLE IF NOT EXISTS relay_cell_fence_plan_bindings (
  attempt_id TEXT PRIMARY KEY,
  plan_object_name TEXT NOT NULL,
  plan_object_generation TEXT,
  var_file_sha256 TEXT NOT NULL,
  terraform_state_lineage TEXT NOT NULL,
  terraform_state_serial BIGINT NOT NULL,
  terraform_state_object_generation TEXT NOT NULL,
  terraform_state_object_sha256 TEXT NOT NULL,
  request_reason TEXT NOT NULL,
  FOREIGN KEY (attempt_id) REFERENCES relay_cell_fence_attempts(attempt_id)
);

CREATE TABLE IF NOT EXISTS relay_cell_fence_apply_invocations (
  invocation_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  request_reason TEXT NOT NULL UNIQUE,
  started_at BIGINT NOT NULL,
  gce_operation TEXT,
  FOREIGN KEY (attempt_id) REFERENCES relay_cell_fence_attempts(attempt_id)
);
CREATE INDEX IF NOT EXISTS relay_cell_fence_apply_invocations_attempt
  ON relay_cell_fence_apply_invocations(attempt_id, started_at);

CREATE TABLE IF NOT EXISTS relay_cell_drain_attempts (
  cell_id TEXT PRIMARY KEY,
  cell_incarnation TEXT NOT NULL,
  planned_grace_ms BIGINT NOT NULL,
  attempted_at BIGINT NOT NULL,
  retry_after BIGINT NOT NULL,
  recover_forward_attempted_at BIGINT
);

CREATE TABLE IF NOT EXISTS relay_cell_drain_attempt_states (
  attempt_id TEXT PRIMARY KEY,
  cell_id TEXT NOT NULL,
  cell_incarnation TEXT NOT NULL,
  trace_value TEXT NOT NULL UNIQUE,
  planned_grace_ms BIGINT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'prepared',
      'send-may-have-started',
      'application-receipt',
      'proven-not-delivered'
    )
  ),
  prepared_at BIGINT NOT NULL,
  send_may_have_started_at BIGINT,
  send_permit_expires_at BIGINT,
  application_receipt_at BIGINT,
  backend_success_status BIGINT,
  backend_instance TEXT,
  receipt_cell_incarnation TEXT,
  retry_after BIGINT,
  recover_forward_attempted_at BIGINT,
  proven_not_delivered_at BIGINT
);
CREATE INDEX IF NOT EXISTS relay_cell_drain_attempt_states_cell
  ON relay_cell_drain_attempt_states(cell_id, prepared_at);

CREATE TABLE IF NOT EXISTS relay_cell_drain_recovery_attempts (
  drain_attempt_id TEXT NOT NULL,
  cell_incarnation TEXT NOT NULL,
  attempted_at BIGINT NOT NULL,
  PRIMARY KEY (drain_attempt_id, cell_incarnation),
  FOREIGN KEY (drain_attempt_id) REFERENCES relay_cell_drain_attempt_states(attempt_id)
);

CREATE TABLE IF NOT EXISTS relay_assignment_activity_leases (
  user_id TEXT NOT NULL,
  relay_host_id TEXT NOT NULL,
  activity_id TEXT NOT NULL,
  activity_kind TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  request_units BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, relay_host_id, activity_id)
);
CREATE INDEX IF NOT EXISTS relay_assignment_activity_expiry
  ON relay_assignment_activity_leases(expires_at);

CREATE TABLE IF NOT EXISTS relay_control_connection_reservations (
  reservation_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  relay_host_id TEXT NOT NULL,
  assignment_epoch BIGINT NOT NULL,
  cell_id TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('reserved', 'late-arrival-debt', 'claimed', 'released')),
  inclusion_watermark BIGINT,
  claim_activity_id TEXT,
  created_at BIGINT NOT NULL,
  timeout_at BIGINT NOT NULL,
  claimed_at BIGINT,
  released_at BIGINT,
  updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS relay_control_connection_reservation_headroom
  ON relay_control_connection_reservations(cell_id, state);
CREATE INDEX IF NOT EXISTS relay_control_connection_reservation_assignment
  ON relay_control_connection_reservations(
    user_id, relay_host_id, assignment_epoch, cell_id, created_at
  );

CREATE TABLE IF NOT EXISTS relay_rate_windows (
  scope_key TEXT NOT NULL,
  window_kind TEXT NOT NULL,
  window_started_at BIGINT NOT NULL,
  count BIGINT NOT NULL,
  PRIMARY KEY (scope_key, window_kind, window_started_at)
);

CREATE TABLE IF NOT EXISTS relay_migration_leases (
  user_id TEXT NOT NULL,
  relay_host_id TEXT NOT NULL,
  source_cell_id TEXT NOT NULL,
  target_cell_id TEXT NOT NULL,
  assignment_epoch BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  completed_at BIGINT,
  PRIMARY KEY (user_id, relay_host_id, assignment_epoch)
);

CREATE TABLE IF NOT EXISTS relay_assignment_migrations (
  user_id TEXT NOT NULL,
  relay_host_id TEXT NOT NULL,
  source_cell_id TEXT NOT NULL,
  target_cell_id TEXT NOT NULL,
  previous_epoch BIGINT NOT NULL,
  assignment_epoch BIGINT NOT NULL,
  source_request_units BIGINT NOT NULL,
  target_reserved_units BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  target_registered_at BIGINT,
  completed_at BIGINT,
  aborted_at BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, relay_host_id, assignment_epoch)
);
CREATE INDEX IF NOT EXISTS relay_assignment_migrations_active
  ON relay_assignment_migrations(expires_at, completed_at, aborted_at);

CREATE TABLE IF NOT EXISTS relay_assignment_migration_incarnations (
  user_id TEXT NOT NULL,
  relay_host_id TEXT NOT NULL,
  assignment_epoch BIGINT NOT NULL,
  source_cell_incarnation TEXT NOT NULL,
  target_cell_incarnation TEXT NOT NULL,
  PRIMARY KEY (user_id, relay_host_id, assignment_epoch)
);

CREATE TABLE IF NOT EXISTS relay_post_drain_migration_pins (
  user_id TEXT NOT NULL,
  relay_host_id TEXT NOT NULL,
  assignment_epoch BIGINT NOT NULL,
  drain_attempt_id TEXT NOT NULL,
  source_cell_id TEXT NOT NULL,
  source_cell_incarnation TEXT NOT NULL,
  target_cell_id TEXT NOT NULL,
  target_cell_incarnation TEXT NOT NULL,
  source_request_units BIGINT NOT NULL,
  target_reserved_units BIGINT NOT NULL,
  pinned_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, relay_host_id, assignment_epoch)
);
CREATE INDEX IF NOT EXISTS relay_post_drain_migration_pins_attempt
  ON relay_post_drain_migration_pins(drain_attempt_id);

CREATE TABLE IF NOT EXISTS relay_audit_events (
  id TEXT PRIMARY KEY,
  at BIGINT NOT NULL,
  type TEXT NOT NULL,
  user_id TEXT,
  relay_host_id TEXT,
  relay_device_id TEXT,
  detail_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS relay_audit_events_at ON relay_audit_events(at);
`

function postgresSql(sql: string): string {
  let index = 0
  return sql.replace(/\?/g, () => `$${++index}`)
}

function returnsRows(sql: string): boolean {
  return /^\s*(select|with)/i.test(sql) || /returning/i.test(sql)
}

const POSTGRES_TRANSACTION_PHASES = [
  ['relay_region_rehome_', 'regional-rehome'],
  ['relay_assignment_activity_leases', 'activity-lease'],
  ['relay_assignment_migration', 'migration'],
  ['relay_migration_leases', 'migration'],
  ['relay_post_drain_migration_pins', 'migration'],
  ['relay_cell_connection_runtime', 'cell-runtime'],
  ['relay_cell_connection_snapshots', 'cell-runtime'],
  ['relay_cell_runtime', 'cell-runtime'],
  ['relay_cell_drain_', 'cell-operation'],
  ['relay_cell_fence', 'cell-operation'],
  ['relay_cell_committed_fences', 'cell-operation'],
  ['relay_cell_legacy_fence_adoptions', 'cell-operation'],
  ['relay_admission_selector', 'admission'],
  ['relay_cell_admission', 'admission'],
  ['relay_control_connection_reservations', 'connection'],
  ['relay_confirmable_splices', 'connection'],
  ['relay_connection_bases', 'connection'],
  ['relay_direct_authorizations', 'connection'],
  ['relay_confirm_results', 'connection'],
  ['relay_assignment_region_preferences', 'assignment'],
  ['relay_assignments', 'assignment'],
  ['relay_cell_', 'cell-inventory'],
  ['relay_cells', 'cell-inventory'],
  ['relay_invites', 'credential'],
  ['relay_devices', 'credential'],
  ['relay_install_results', 'credential'],
  ['relay_rate_windows', 'rate-limit'],
  ['relay_audit_events', 'audit']
] as const

const postgresTransactionPhaseByError = new WeakMap<object, string>()

function postgresTransactionPhase(sql: string): string {
  const normalized = sql.toLowerCase()
  return POSTGRES_TRANSACTION_PHASES.find(([table]) => normalized.includes(table))?.[1] ?? 'other'
}

function rememberPostgresTransactionPhase(error: unknown, sql: string): void {
  if (typeof error === 'object' && error !== null) {
    postgresTransactionPhaseByError.set(error, postgresTransactionPhase(sql))
  }
}

function postgresTransactionErrorPhase(error: unknown): string {
  return typeof error === 'object' && error !== null
    ? (postgresTransactionPhaseByError.get(error) ?? 'transaction')
    : 'transaction'
}

class SqliteTransaction implements RelayDatabase {
  readonly dialect = 'sqlite' as const
  private heldFromMs: number | undefined

  constructor(protected readonly database: DatabaseSync) {}

  consumeHoldMs(): number | undefined {
    if (this.heldFromMs === undefined) return undefined
    const holdMs = performance.now() - this.heldFromMs
    this.heldFromMs = undefined
    return holdMs
  }

  protected noteHeld(options: RelayLockOptions): void {
    if (options.measureHoldMs && this.heldFromMs === undefined) {
      this.heldFromMs = performance.now()
    }
  }

  async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    const statement = this.database.prepare(sql)
    const bound = params.map((value) => (value === undefined ? null : value)) as never[]
    if (returnsRows(sql)) return statement.all(...bound) as SqlRow[]
    const result = statement.run(...bound)
    return [{ changes: Number(result.changes) }]
  }

  async queryLocked(
    sql: string,
    params: unknown[] = [],
    options: RelayLockOptions = {}
  ): Promise<SqlRow[]> {
    const rows = await this.query(sql, params)
    this.noteHeld(options)
    return rows
  }

  async transaction<T>(
    operation: (transaction: RelayDatabase) => Promise<T>,
    _options: RelayTransactionOptions = {}
  ): Promise<T> {
    return await operation(this)
  }

  async close(): Promise<void> {}
}

class SqliteDatabase extends SqliteTransaction {
  private tail: Promise<void> = Promise.resolve()
  private readonly holds = new CellInventoryHoldSamples()

  consumeHoldCounts(): CellInventoryHoldCounts {
    return this.holds.consumeCounts()
  }

  override async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    await this.tail
    return await super.query(sql, params)
  }

  override async transaction<T>(operation: (transaction: RelayDatabase) => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise((resolve) => (release = resolve))
    await previous
    this.database.exec('BEGIN IMMEDIATE')
    const transaction = new SqliteTransaction(this.database)
    try {
      const result = await operation(transaction)
      this.database.exec('COMMIT')
      this.holds.record(measuredHoldMs(transaction) ?? Number.NaN)
      return result
    } catch (error) {
      this.database.exec('ROLLBACK')
      throw error
    } finally {
      release()
    }
  }

  override async close(): Promise<void> {
    await this.tail
    this.database.close()
  }
}

class PostgresTransaction implements RelayDatabase {
  readonly dialect = 'postgres' as const
  private heldFromMs: number | undefined

  constructor(protected readonly client: pg.PoolClient) {}

  consumeHoldMs(): number | undefined {
    if (this.heldFromMs === undefined) return undefined
    const holdMs = performance.now() - this.heldFromMs
    this.heldFromMs = undefined
    return holdMs
  }

  async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    try {
      const result = await this.client.query(postgresSql(sql), params)
      return returnsRows(sql) ? (result.rows as SqlRow[]) : [{ changes: result.rowCount ?? 0 }]
    } catch (error) {
      rememberPostgresTransactionPhase(error, sql)
      throw error
    }
  }

  async queryLocked(
    sql: string,
    params: unknown[] = [],
    options: RelayLockOptions = {}
  ): Promise<SqlRow[]> {
    // SET LOCAL lasts to COMMIT, so a bound left in place would silently govern
    // every later locked statement in the transaction and misattribute its 55P03s.
    const bounded = options.lockTimeoutMs !== undefined && !options.failIfUnavailable
    try {
      // A blocked waiter holds its pooled client for the whole lock_timeout, so
      // hot tiny-table locks bound their own wait well under the pool default.
      if (bounded) await this.query(setLocalLockTimeout(options.lockTimeoutMs!))
      const rows = await this.query(
        `${sql} FOR UPDATE${options.failIfUnavailable ? ' NOWAIT' : ''}`,
        params
      )
      if (options.measureHoldMs && this.heldFromMs === undefined) {
        this.heldFromMs = performance.now()
      }
      return rows
    } catch (error) {
      if (
        options.failIfUnavailable &&
        String((error as { code?: unknown }).code) === '55P03'
      ) {
        throw new Error('database_lock_unavailable')
      }
      throw error
    } finally {
      // Restore on the error path too: the transaction may still be retried or
      // continue with unrelated locks after a caught lock failure.
      if (bounded) await this.query(setLocalLockTimeout(POSTGRES_LOCK_TIMEOUT_MS)).catch(() => undefined)
    }
  }

  async transaction<T>(
    operation: (transaction: RelayDatabase) => Promise<T>,
    _options: RelayTransactionOptions = {}
  ): Promise<T> {
    return await operation(this)
  }

  async close(): Promise<void> {}
}

const POSTGRES_TRANSACTION_ATTEMPTS = 3
const POSTGRES_RETRY_MAX_DELAY_MS = 25
const POSTGRES_CONNECTION_TIMEOUT_MS = 2_000
// Derivation: a control renewal must land inside its own 30s tick
// (RELAY_PROTOCOL_LIMITS.controlPingIntervalMs * 2), and a transaction gets
// POSTGRES_TRANSACTION_ATTEMPTS tries, so the worst case a renewal can spend in
// Postgres is attempts * timeout. 5s keeps that at 15s, half the tick, and still
// leaves room for the connect timeout above.
export const POSTGRES_STATEMENT_TIMEOUT_MS = 5_000
const POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS = 5_000

export function relayPostgresStatementTimeoutMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const configured = env.ORCA_RELAY_POSTGRES_STATEMENT_TIMEOUT_MS
  if (configured === undefined || configured === '') return POSTGRES_STATEMENT_TIMEOUT_MS
  const milliseconds = Number(configured)
  // 0 is PostgreSQL's "no timeout"; refusing it keeps the deadline this exists
  // to enforce from being disabled by a typo in an environment variable.
  if (!Number.isInteger(milliseconds) || milliseconds < 1) {
    throw new Error('invalid_statement_timeout')
  }
  return milliseconds
}

function retryablePostgresTransactionError(error: unknown): boolean {
  const code = String((error as { code?: unknown }).code)
  // 57014 is the pool statement_timeout firing. It aborts the transaction the
  // same way a lock timeout does, so it belongs on the bounded retry path
  // rather than surfacing as a terminal failure to the caller.
  return code === '40P01' || code === '40001' || code === '55P03' || code === '57014'
}

export function isRelayDatabaseTransientError(error: unknown): boolean {
  const code = String((error as { code?: unknown }).code)
  if (['40P01', '40001', '55P03', '57014', '53300', '57P03', '08001', '08006'].includes(code)) {
    return true
  }
  return String((error as { message?: unknown }).message).includes(
    'timeout exceeded when trying to connect'
  )
}

async function waitForPostgresRetry(random: () => number = Math.random): Promise<void> {
  const delayMs = Math.floor(random() * (POSTGRES_RETRY_MAX_DELAY_MS + 1))
  await new Promise((resolve) => setTimeout(resolve, delayMs))
}

class PostgresDatabase implements RelayDatabase {
  readonly dialect = 'postgres' as const
  private readonly pressure: PostgresPoolPressure
  private readonly holds = new CellInventoryHoldSamples()

  consumeHoldCounts(): CellInventoryHoldCounts {
    return this.holds.consumeCounts()
  }

  constructor(private readonly pool: pg.Pool) {
    this.pressure = new PostgresPoolPressure(pool)
  }

  async query(sql: string, params: unknown[] = []): Promise<SqlRow[]> {
    const client = await this.pressure.connect()
    try {
      const result = await client.query(postgresSql(sql), params)
      return returnsRows(sql) ? (result.rows as SqlRow[]) : [{ changes: result.rowCount ?? 0 }]
    } finally {
      client.release()
    }
  }

  async queryLocked(
    sql: string,
    params: unknown[] = [],
    options: RelayLockOptions = {}
  ): Promise<SqlRow[]> {
    try {
      // No transaction here, so options.lockTimeoutMs cannot apply: SET LOCAL
      // would be discarded at the autocommit boundary before the lock is taken.
      return await this.query(
        `${sql} FOR UPDATE${options.failIfUnavailable ? ' NOWAIT' : ''}`,
        params
      )
    } catch (error) {
      if (
        options.failIfUnavailable &&
        String((error as { code?: unknown }).code) === '55P03'
      ) {
        throw new Error('database_lock_unavailable')
      }
      throw error
    }
  }

  async transaction<T>(
    operation: (transaction: RelayDatabase) => Promise<T>,
    options: RelayTransactionOptions = {}
  ): Promise<T> {
    for (let attempt = 1; attempt <= POSTGRES_TRANSACTION_ATTEMPTS; attempt++) {
      const client = await this.pressure.connect()
      const transaction = new PostgresTransaction(client)
      try {
        await client.query('BEGIN')
        const result = await operation(transaction)
        await client.query('COMMIT')
        this.holds.record(measuredHoldMs(transaction) ?? Number.NaN)
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        if (!retryablePostgresTransactionError(error) || attempt === POSTGRES_TRANSACTION_ATTEMPTS) {
          if (retryablePostgresTransactionError(error) && options.reportRetries !== false) {
            console.warn(
              JSON.stringify({
                event: 'orca_relay_postgres_transaction_exhausted',
                code: String((error as { code?: unknown }).code),
                attempts: attempt,
                phase: postgresTransactionErrorPhase(error)
              })
            )
          }
          throw error
        }
        if (options.reportRetries !== false) {
          console.warn(
            JSON.stringify({
              event: 'orca_relay_postgres_transaction_retry',
              code: String((error as { code?: unknown }).code),
              attempt,
              phase: postgresTransactionErrorPhase(error)
            })
          )
        }
      } finally {
        client.release()
      }
      // A PostgreSQL transaction is unusable after an abort, so retry all work
      // on a fresh pooled client with a small full-jitter delay.
      await waitForPostgresRetry()
    }
    throw new Error('postgres_transaction_retry_exhausted')
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  consumePoolPressure(): PostgresPoolPressureCounts {
    return this.pressure.consumeCounts()
  }

  peekPoolPressure(): PostgresPoolPressureCounts {
    return this.pressure.peekCounts()
  }
}

export function consumeRelayDatabasePoolPressure(
  database: RelayDatabase
): PostgresPoolPressureCounts {
  return database instanceof PostgresDatabase
    ? database.consumePoolPressure()
    : emptyPostgresPoolPressureCounts()
}

export function consumeRelayCellInventoryHold(
  database: RelayDatabase
): CellInventoryHoldCounts {
  const holder = database as { consumeHoldCounts?: () => CellInventoryHoldCounts }
  return holder.consumeHoldCounts?.() ?? emptyCellInventoryHoldCounts()
}

export function readRelayDatabasePoolPressure(
  database: RelayDatabase
): PostgresPoolPressureCounts {
  return database instanceof PostgresDatabase
    ? database.peekPoolPressure()
    : emptyPostgresPoolPressureCounts()
}

export function absorbPostgresIdleClientErrors(pool: Pick<pg.Pool, 'on'>): void {
  pool.on('error', () => {
    // Why: node-postgres removes failed idle clients itself; leaving `error`
    // unhandled would crash the cell and turn a SQL outage into autoheal churn.
    console.warn('[orca-relay] idle PostgreSQL client failed')
  })
}

async function applySchema(database: RelayDatabase): Promise<void> {
  for (const statement of SCHEMA.split(';')) {
    if (statement.trim()) await database.query(statement)
  }
}

// Why: DDL is not a request. A CREATE INDEX on a grown table legitimately runs
// longer than the request statement_timeout, and inheriting that timeout would
// make every startup fail at the same statement instead of finishing once. One
// short-lived connection of its own, ended before the serving pool opens, keeps
// the untimed session off the request path entirely.
async function applySchemaOnUntimedPool(
  databaseUrl: string,
  applicationName: string | undefined
): Promise<void> {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    application_name: applicationName ? `${applicationName}/schema` : undefined,
    connectionTimeoutMillis: POSTGRES_CONNECTION_TIMEOUT_MS,
    statement_timeout: 0,
    // Kept: a DDL blocked behind another director's ACCESS EXCLUSIVE lock must
    // yield to the bounded schema retry instead of holding the connection.
    lock_timeout: POSTGRES_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS
  })
  absorbPostgresIdleClientErrors(pool)
  const database = new PostgresDatabase(pool)
  try {
    await applyPostgresSchema(
      SCHEMA.split(';').filter((statement) => statement.trim()),
      async (statement) => await database.query(statement)
    )
  } finally {
    await database.close().catch(() => undefined)
  }
}

async function backfillRelayCellRegions(database: RelayDatabase): Promise<void> {
  await database.query(
    `INSERT INTO relay_cell_regions (cell_id, region)
     SELECT cell_id, 'us-central1' FROM relay_cells WHERE true
     ON CONFLICT (cell_id) DO NOTHING`
  )
}

export async function openRelayDatabase(input: {
  databaseUrl?: string
  dataDir: string
  poolMax?: number
  applicationName?: string
  statementTimeoutMs?: number
}): Promise<RelayDatabase> {
  let database: RelayDatabase
  if (input.databaseUrl) {
    await applySchemaOnUntimedPool(input.databaseUrl, input.applicationName)
    const pool = new pg.Pool({
      connectionString: input.databaseUrl,
      max: input.poolMax ?? 10,
      application_name: input.applicationName,
      connectionTimeoutMillis: POSTGRES_CONNECTION_TIMEOUT_MS,
      statement_timeout: input.statementTimeoutMs ?? relayPostgresStatementTimeoutMs(),
      lock_timeout: POSTGRES_LOCK_TIMEOUT_MS,
      idle_in_transaction_session_timeout: POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS
    })
    absorbPostgresIdleClientErrors(pool)
    database = new PostgresDatabase(pool)
  } else {
    mkdirSync(input.dataDir, { recursive: true })
    const sqlite = new DatabaseSync(join(input.dataDir, 'orca-relay.sqlite'))
    sqlite.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    database = new SqliteDatabase(sqlite)
  }
  try {
    if (!input.databaseUrl) await applySchema(database)
    await backfillRelayCellRegions(database)
    return database
  } catch (error) {
    await database.close().catch(() => undefined)
    throw error
  }
}

export async function openInMemoryRelayDatabase(): Promise<RelayDatabase> {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON;')
  const database = new SqliteDatabase(sqlite)
  await applySchema(database)
  await backfillRelayCellRegions(database)
  return database
}
