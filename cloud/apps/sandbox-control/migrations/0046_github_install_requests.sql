-- GitHub App installation requests made from Orca by a GitHub user who isn't an owner of the org
-- (GitHub's "Request" button; the setup URL returns with setup_action=request). The requester's
-- GitHub identity is proven with OAuth before a row is written. When an org owner approves, the
-- `installation.created` webhook names the same requester, and that installation is bound to the
-- Orca account that asked (github_installations.method = 'request').
CREATE TABLE github_install_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  github_user_id INTEGER NOT NULL,
  github_login TEXT NOT NULL,
  -- Lowercased GitHub owner (org) login the request is for, from the repository it was made for.
  owner_login TEXT NOT NULL,
  -- https://github.com/<owner>/<repo> the request was made for, and the setup session waiting on it.
  repo_url TEXT,
  setup_session_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER,
  installation_id INTEGER
);
CREATE INDEX github_install_requests_account ON github_install_requests (account_id, owner_login);
CREATE INDEX github_install_requests_requester ON github_install_requests (github_user_id, owner_login);
