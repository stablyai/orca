-- Display names teammates see next to a member id (owner, creator, last active, presence), taken
-- from the `name` claim on that member's own sandbox token. Labels only: never used for access.
-- Additive: older Workers ignore the table; rows without one fall back to the org roster or the id.
CREATE TABLE member_names (
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, user_id)
);
