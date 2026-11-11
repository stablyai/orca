-- Teammate profiles and Pokes (team-presence). Additive; older Workers ignore all of it.
--
-- member_usage_hours: model spend each member's own client reported, by UTC hour. Filled from the
-- deltas of the cumulative sandboxes.token_usd_micros a client PATCHes, so it accrues from the
-- deploy onward. Compute time comes from usage_outbox and is not copied here.
CREATE TABLE IF NOT EXISTS member_usage_hours (
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  hour INTEGER NOT NULL, -- floor(ms / 3_600_000)
  token_usd_micros INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, user_id, hour)
);

-- Heatmap reads compute segments per account and time window.
CREATE INDEX IF NOT EXISTS usage_outbox_account_started ON usage_outbox (account_id, started_at);

-- Pokes are opt-in (Settings → Experimental): a poke goes through only when both people have it on.
CREATE TABLE IF NOT EXISTS member_poke_prefs (
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, user_id)
);

CREATE TABLE IF NOT EXISTS member_pokes (
  id TEXT PRIMARY KEY, -- pok_<24 hex>
  account_id TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  to_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  seen_at INTEGER
);
CREATE INDEX IF NOT EXISTS member_pokes_inbox ON member_pokes (account_id, to_user_id, created_at);
CREATE INDEX IF NOT EXISTS member_pokes_sender ON member_pokes (account_id, from_user_id, created_at);
