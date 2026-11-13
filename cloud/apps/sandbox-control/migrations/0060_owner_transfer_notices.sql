-- OWNER-TRANSFER: a notice for the previous owner when their workspace changes owner. The desktop
-- shows it until they dismiss it: who made the change, who owns it now, and that personal secrets
-- they used there may still be on its disk. Names only, never a secret. Additive.
CREATE TABLE owner_transfer_notices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  -- The previous owner: who the notice is for.
  user_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  -- As they were at the hand-off; the workspace may be renamed or deleted later.
  workspace_name TEXT,
  workspace_number INTEGER,
  actor_user_id TEXT NOT NULL,
  new_owner_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  dismissed_at INTEGER
);
CREATE INDEX owner_transfer_notices_user ON owner_transfer_notices (account_id, user_id, dismissed_at);
