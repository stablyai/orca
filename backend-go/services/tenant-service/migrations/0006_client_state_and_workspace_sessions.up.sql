-- Adds 5 opaque per-user JSON columns to tenant.user_profiles
-- (CR-STORAGE-001/003/004b — keybindings, UI local state, saved runtime
-- environments, client settings, accounts->dev-server map) and a new
-- tenant.user_workspace_sessions table for CR-STORAGE-004a's per-(user,host)
-- workspace session state. See specs/backend-go/crs/v3/storage/solutions/
-- BE-SOL-STORAGE-001-user-profile-json-columns.md for the full design.
--
-- TEXT not JSONB, additive/nullable — mirrors onboarding_state_json's
-- existing column shape (0003_add_onboarding_state.up.sql): every value here
-- is opaque frontend JSON, tenant-service never queries into it, so there is
-- no need for JSONB's indexing/containment operators.
ALTER TABLE tenant.user_profiles
  ADD COLUMN keybindings_json                TEXT NULL,
  ADD COLUMN ui_local_state_json             TEXT NULL,
  ADD COLUMN saved_runtime_environments_json TEXT NULL,
  ADD COLUMN client_settings_json            TEXT NULL,
  ADD COLUMN accounts_dev_server_json        TEXT NULL;

-- workspace_session_json is NOT a 6th user_profiles column: CR-STORAGE-004a
-- needs an extra host_id dimension per user (mirrors the frontend's
-- sessionStorageKeyForHost()), and one user can have N sessions, not 1 — see
-- BE-SOL-STORAGE-001 §3.
CREATE TABLE tenant.user_workspace_sessions (
  user_id      UUID NOT NULL,       -- logical FK -> auth.users (different DB)
  company_id   UUID NOT NULL REFERENCES tenant.companies(id),
  host_id      TEXT NOT NULL,       -- 'local'/environmentId; '' = default host
  session_json TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, host_id)
);
CREATE INDEX idx_user_workspace_sessions_company ON tenant.user_workspace_sessions (company_id);

-- Row-Level Security as defense-in-depth, same pattern as every other
-- tenant-scoped table (0001_init.up.sql) — must not be skipped for a new
-- table just because it's additive.
ALTER TABLE tenant.user_workspace_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant.user_workspace_sessions
    USING (company_id = current_setting('app.tenant_id', true)::uuid);
