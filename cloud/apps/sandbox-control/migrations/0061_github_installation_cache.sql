-- CREATE-GH-STEP: the create wizard's "GitHub access" step asks repo-access for every create and
-- polls it every 2 s while the person installs the App. GitHub's installation lookups (app JWT, one
-- per repository and owner) are cached here for a short TTL, shared by every isolate, and dropped by
-- the installation webhooks and the setup return so a fresh install answers on the next poll.
-- No credential or token is stored: installation ids and the owner's login only. Additive.
CREATE TABLE github_installation_cache (
  -- '<owner>/<repo>' for a repository lookup, '<owner>/' for an owner lookup; lowercased.
  cache_key TEXT PRIMARY KEY,
  owner_key TEXT NOT NULL,
  -- NULL: GitHub answered 404 (the App isn't installed there, or not on this repository).
  installation_id INTEGER,
  github_account_id INTEGER,
  github_account_login TEXT,
  github_account_type TEXT,
  checked_at INTEGER NOT NULL
);
CREATE INDEX github_installation_cache_owner ON github_installation_cache (owner_key);
CREATE INDEX github_installation_cache_installation ON github_installation_cache (installation_id);
