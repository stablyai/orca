-- Team workspace registry. A sandbox row is the cloud-owned record of one workspace: who made it,
-- who owns it now (`user_id`, reassignable), who in the org can see it. Name and archive reuse
-- `name` / `archived_at` from 0020 (W5); routine-made rows (`hidden`) stay out of team lists.
ALTER TABLE sandboxes ADD COLUMN created_by TEXT;
ALTER TABLE sandboxes ADD COLUMN repo_branch TEXT;
-- private (default): owner only. team: every member of the owning org can see and open it.
ALTER TABLE sandboxes ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
ALTER TABLE sandboxes ADD COLUMN section TEXT;
ALTER TABLE sandboxes ADD COLUMN last_activity_at INTEGER;
ALTER TABLE sandboxes ADD COLUMN last_activity_by TEXT;
-- Optional model spend the workspace's agents reported (USD micros); null = never reported.
ALTER TABLE sandboxes ADD COLUMN token_usd_micros INTEGER;
UPDATE sandboxes SET created_by = user_id WHERE created_by IS NULL;
CREATE INDEX sandboxes_account_visibility ON sandboxes (account_id, visibility, status);

-- Who is looking at / typing in a workspace right now. Heartbeat rows; stale after 45 s.
CREATE TABLE workspace_presence (
  sandbox_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  -- one row per member device, so two laptops of one member do not flap each other
  client_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('viewing', 'typing')),
  chat_id TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (sandbox_id, user_id, client_id)
);
CREATE INDEX workspace_presence_recent ON workspace_presence (sandbox_id, updated_at);

-- Per-member, per-device access to a workspace's orcad. The pairing offer itself never lands here:
-- the VM seals it to the requesting device's X25519 key, and only the device id is recorded so the
-- grant can be revoked (removed from orcad's device registry) later.
CREATE TABLE workspace_grants (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes (id),
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  device_kind TEXT NOT NULL CHECK (device_kind IN ('desktop', 'mobile')),
  device_label TEXT NOT NULL,
  -- orcad device id from the minted offer; null until the VM answered.
  orcad_device_id TEXT,
  -- issuing | active | revoking (queued: applied at next boot) | revoked | failed
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT,
  revoke_reason TEXT,
  -- Phone device session that requested it (W8); revoking the session revokes its grants.
  device_session_id TEXT
);
CREATE INDEX workspace_grants_sandbox ON workspace_grants (sandbox_id, status);
CREATE INDEX workspace_grants_user ON workspace_grants (account_id, user_id, status);

-- Org-synced prompts and PR instructions (simple key/value documents per org account).
CREATE TABLE org_prompts (
  account_id TEXT PRIMARY KEY,
  -- JSON: {prompts:[{id,name,body}], prInstructions}
  document TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

-- Per-member GitHub user-to-server tokens (GitHub App OAuth), envelope-encrypted like secrets.
-- They never enter a VM: the egress proxy swaps a member placeholder for the token, only for the
-- workspace repository, so pushes land on GitHub as the member who made them.
CREATE TABLE github_user_tokens (
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  github_user_id INTEGER NOT NULL,
  github_login TEXT NOT NULL,
  github_name TEXT,
  kek_id TEXT NOT NULL,
  wrapped_dek TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  access_expires_at INTEGER,
  refresh_expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, user_id)
);
