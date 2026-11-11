-- G14: every cloud workspace gets a short number in its account (W-123), allocated from a per-account
-- counter so a number is never reused, even after the row is destroyed. Orgs get a URL slug for links
-- (orca://cloud/<slug>/W-123). G13: each member's sidebar prefs for cloud workspaces (pins, their
-- order, and the order of sections) live on the account so every device shows the same sidebar.
ALTER TABLE sandboxes ADD COLUMN number INTEGER;

-- Backfill: existing rows numbered by creation order within their account.
UPDATE sandboxes SET number = (
  SELECT COUNT(*) FROM sandboxes AS earlier
  WHERE earlier.account_id = sandboxes.account_id
    AND (earlier.created_at < sandboxes.created_at OR (earlier.created_at = sandboxes.created_at AND earlier.id <= sandboxes.id))
);

CREATE UNIQUE INDEX sandboxes_account_number ON sandboxes (account_id, number) WHERE number IS NOT NULL;

CREATE TABLE org_workspace_counters (
  account_id TEXT PRIMARY KEY,
  last_number INTEGER NOT NULL
);

INSERT INTO org_workspace_counters (account_id, last_number)
  SELECT account_id, MAX(number) FROM sandboxes GROUP BY account_id;

CREATE TABLE org_slugs (
  account_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE workspace_prefs (
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  document TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by_device TEXT,
  PRIMARY KEY (account_id, user_id)
);
