-- When auth last told us a member's role changed or they left an account. A desktop token issued
-- at or before that moment carries a stale role or membership, so it may not re-sync key roles or
-- enroll (or re-vouch) a phone. Additive; one row per (account, member).
CREATE TABLE IF NOT EXISTS member_changes (
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  removed_at INTEGER,
  PRIMARY KEY (account_id, user_id)
);
