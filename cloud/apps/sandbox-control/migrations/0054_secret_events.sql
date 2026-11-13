-- SEC-4: customer-visible activity for cloud secrets. One row per create, update or delete: who,
-- when, which scope and owner, and the variable NAME. Never a value, hint, ciphertext or key.
CREATE TABLE secret_events (
  id TEXT PRIMARY KEY,
  -- Whose log this is: the team account (org:<id>) for Shared and team Repository secrets, or the
  -- user's personal owner id (user:<id>) for Personal secrets and a personal account's Repository ones.
  account_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('org', 'personal', 'repo')),
  -- secrets.owner_id of the row that changed.
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'updated', 'deleted')),
  actor_user_id TEXT NOT NULL,
  -- Display name from the actor's token at the time (label only, may be null).
  actor_name TEXT,
  -- The team the actor's token was for (null for a personal-account token).
  actor_org_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX secret_events_account ON secret_events (account_id, created_at DESC, id DESC);
