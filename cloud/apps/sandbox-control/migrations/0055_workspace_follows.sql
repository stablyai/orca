-- PARITY-FOLLOW: a member follows a teammate's workspace to keep it in their sidebar's Following
-- section; everyone who can see the workspace sees its followers. One row per member per
-- workspace. Rows go with the workspace (destroy) and with the member (removal); a follower who can
-- no longer see the workspace (it turned private) is left out of every read.
CREATE TABLE IF NOT EXISTS workspace_follows (
  sandbox_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (sandbox_id, user_id)
);
CREATE INDEX IF NOT EXISTS workspace_follows_member ON workspace_follows (account_id, user_id);
