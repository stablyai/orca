-- Cloud setup sessions (NP-4 N1): one browser trip that chains sign-in, team, plan and GitHub.
-- The desktop creates a session after sign-in and polls it; the setup pages on Orca Cloud auth
-- (auth.onorca.dev/cloud/setup/...) read and advance it; the control plane flips the GitHub step.
-- Times are epoch milliseconds. Additive only.
CREATE TABLE cloud_setup_sessions (
  id TEXT PRIMARY KEY,
  -- Orca user who created it (billing token `sub`); every page and poll must be that user.
  user_id TEXT NOT NULL,
  -- 'org:<orgId>' once a team is chosen or created; null until then (setup never bills a user:).
  account_id TEXT,
  team_name TEXT,
  -- 1 when setup created the team (shown as "Rename team" on the done page).
  team_created INTEGER NOT NULL DEFAULT 0,
  -- https://github.com/<owner>/<repo>, lower-cased, no .git; null when no repository is involved.
  repo TEXT,
  -- JSON array of the steps the desktop asked for: subset of ["team","plan","github"].
  needs TEXT NOT NULL,
  -- Label of the device waiting for this session ("MacBook Pro"), shown on the account page.
  device TEXT,
  -- 'month' | 'year', chosen on the plan page.
  billing_interval TEXT,
  -- null | 'open' | 'canceled' | 'paid'
  checkout_state TEXT,
  -- null | 'pending' (owner approval requested on GitHub) | 'done'
  github_state TEXT,
  -- Latest error for the tracker (X1): timed_out | checkout_canceled | bank_step | trial_unavailable
  -- | team_create_failed | wrong_account; cleared when the step moves on.
  error_kind TEXT,
  error_detail TEXT,
  -- One-time browser ticket (SHA-256 hex) that lets the setup pages adopt this session's user.
  ticket_hash TEXT,
  ticket_expires_at INTEGER,
  finished_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX cloud_setup_sessions_user ON cloud_setup_sessions(user_id, created_at);
CREATE INDEX cloud_setup_sessions_account_repo ON cloud_setup_sessions(account_id, repo);
