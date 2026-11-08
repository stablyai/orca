// GENERATED from the relay's SQLite schema (sqlite_master) by test/object-store-schema.test.ts.
// Do not edit; regenerate with UPDATE_OBJECT_STORE_SCHEMA=1.
export const OBJECT_STORE_SCHEMA: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS relay_audit_events (\n  id TEXT PRIMARY KEY,\n  at BIGINT NOT NULL,\n  type TEXT NOT NULL,\n  user_id TEXT,\n  relay_host_id TEXT,\n  relay_device_id TEXT,\n  detail_json TEXT NOT NULL\n)",
  "CREATE TABLE IF NOT EXISTS relay_confirm_results (\n  user_id TEXT NOT NULL,\n  relay_host_id TEXT NOT NULL,\n  req_id TEXT NOT NULL,\n  basis_conn_id TEXT NOT NULL,\n  tuple_json TEXT NOT NULL,\n  result_json TEXT NOT NULL,\n  committed_at BIGINT NOT NULL,\n  PRIMARY KEY (user_id, relay_host_id, req_id)\n)",
  "CREATE TABLE IF NOT EXISTS relay_connection_bases (\n  basis_conn_id TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL,\n  relay_host_id TEXT NOT NULL,\n  relay_device_id TEXT NOT NULL,\n  owning_control_generation BIGINT NOT NULL,\n  credential_kind TEXT NOT NULL,\n  invite_token_hash TEXT,\n  accepted_credential_version BIGINT,\n  accepted_as TEXT,\n  deadline BIGINT NOT NULL,\n  active BIGINT NOT NULL,\n  created_at BIGINT NOT NULL\n)",
  "CREATE TABLE IF NOT EXISTS relay_devices (\n  user_id TEXT NOT NULL,\n  relay_host_id TEXT NOT NULL,\n  relay_device_id TEXT NOT NULL,\n  current_hash TEXT NOT NULL,\n  current_version BIGINT NOT NULL,\n  current_expires_at BIGINT NOT NULL,\n  grace_hash TEXT,\n  grace_version BIGINT,\n  grace_expires_at BIGINT,\n  revoked_at BIGINT,\n  updated_at BIGINT NOT NULL,\n  PRIMARY KEY (user_id, relay_host_id, relay_device_id)\n)",
  "CREATE TABLE IF NOT EXISTS relay_direct_authorizations (\n  direct_auth_id TEXT PRIMARY KEY,\n  user_id TEXT NOT NULL,\n  relay_host_id TEXT NOT NULL,\n  relay_device_id TEXT NOT NULL,\n  owning_control_generation BIGINT NOT NULL,\n  deadline BIGINT NOT NULL,\n  consumed_at BIGINT\n)",
  "CREATE TABLE IF NOT EXISTS relay_install_results (\n  user_id TEXT NOT NULL,\n  relay_host_id TEXT NOT NULL,\n  relay_device_id TEXT NOT NULL,\n  req_id TEXT NOT NULL,\n  authorization_mode TEXT NOT NULL,\n  result_json TEXT NOT NULL,\n  committed_at BIGINT NOT NULL,\n  PRIMARY KEY (user_id, relay_host_id, relay_device_id, req_id)\n)",
  "CREATE TABLE IF NOT EXISTS relay_invites (\n  user_id TEXT NOT NULL,\n  relay_host_id TEXT NOT NULL,\n  relay_device_id TEXT NOT NULL,\n  token_hash TEXT NOT NULL UNIQUE,\n  state TEXT NOT NULL,\n  attempt_count BIGINT NOT NULL,\n  max_attempts BIGINT NOT NULL,\n  expires_at BIGINT NOT NULL,\n  reservation_id TEXT,\n  reservation_expires_at BIGINT,\n  cooldown_until BIGINT,\n  created_at BIGINT NOT NULL,\n  updated_at BIGINT NOT NULL,\n  PRIMARY KEY (user_id, relay_host_id, relay_device_id, token_hash)\n)",
  "CREATE TABLE IF NOT EXISTS relay_rate_windows (\n  scope_key TEXT NOT NULL,\n  window_kind TEXT NOT NULL,\n  window_started_at BIGINT NOT NULL,\n  count BIGINT NOT NULL,\n  PRIMARY KEY (scope_key, window_kind, window_started_at)\n)",
  "CREATE INDEX IF NOT EXISTS relay_audit_events_at ON relay_audit_events(at)",
  "CREATE INDEX IF NOT EXISTS relay_connection_bases_active_deadline\n  ON relay_connection_bases(active, deadline)",
  "CREATE INDEX IF NOT EXISTS relay_devices_current_hash ON relay_devices(relay_host_id, current_hash)",
  "CREATE INDEX IF NOT EXISTS relay_devices_grace_hash ON relay_devices(relay_host_id, grace_hash)",
  "CREATE INDEX IF NOT EXISTS relay_direct_authorizations_pending_deadline\n  ON relay_direct_authorizations(deadline) WHERE consumed_at IS NULL",
  "CREATE INDEX IF NOT EXISTS relay_invites_device\n  ON relay_invites(user_id, relay_host_id, relay_device_id)",
  "CREATE INDEX IF NOT EXISTS relay_invites_sweep_expiry\n  ON relay_invites(expires_at) WHERE state IN ('available', 'reserved', 'cooldown')",
  "CREATE INDEX IF NOT EXISTS relay_invites_sweep_reservation\n  ON relay_invites(reservation_expires_at) WHERE state = 'reserved'",
  "CREATE INDEX IF NOT EXISTS relay_rate_windows_started\n  ON relay_rate_windows(window_started_at)"
]
