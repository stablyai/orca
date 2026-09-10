export function createMaestroBrowserSurfaceTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS maestro_browser_surfaces (
  surface_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  execution_host_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  owner_principal TEXT NOT NULL,
  ownership TEXT NOT NULL CHECK(ownership IN ('harness', 'user')),
  browser_page_id TEXT,
  navigation_url TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'reserved', 'creating', 'active', 'retained', 'release_pending',
    'released', 'outcome_unknown', 'unavailable'
  )),
  retention TEXT NOT NULL CHECK(retention IN ('release_when_settled', 'retain')),
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_maestro_browser_surface_attempt
  ON maestro_browser_surfaces(execution_host_id, workspace_key, run_id, task_id, attempt_id)
  WHERE state NOT IN ('released');
CREATE UNIQUE INDEX IF NOT EXISTS idx_maestro_browser_surface_live_page
  ON maestro_browser_surfaces(execution_host_id, workspace_key, browser_page_id)
  WHERE browser_page_id IS NOT NULL AND state NOT IN ('released');
CREATE INDEX IF NOT EXISTS idx_maestro_browser_surface_reconciliation
  ON maestro_browser_surfaces(state, retention, ownership, updated_at);
CREATE TABLE IF NOT EXISTS maestro_browser_profile_consents (
  consent_id TEXT PRIMARY KEY,
  execution_host_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_maestro_browser_profile_consent_active
  ON maestro_browser_profile_consents(
    execution_host_id, workspace_key, run_id, task_id, attempt_id, profile_id
  ) WHERE revoked_at IS NULL;
`
}
