-- Billing ledger (D1). Identity (users, orgs, membership, roles) stays in Orca Cloud auth;
-- billing only stores the account id the auth token names. Times are epoch milliseconds.

-- One row per billable account: an org ('org:<orgId>') or a signed-in user without an org
-- ('user:<userId>').
CREATE TABLE billing_accounts (
  account_id TEXT PRIMARY KEY,
  stripe_customer_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Mirror of the Stripe subscription, rewritten from a fresh API read on every webhook so
-- out-of-order deliveries cannot regress it.
CREATE TABLE subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES billing_accounts(account_id),
  stripe_customer_id TEXT NOT NULL,
  status TEXT NOT NULL,
  plan TEXT NOT NULL,
  seats INTEGER NOT NULL,
  overage_enabled INTEGER NOT NULL,
  current_period_start INTEGER NOT NULL,
  current_period_end INTEGER NOT NULL,
  cancel_at_period_end INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX subscriptions_account ON subscriptions(account_id, current_period_end);

-- Webhook idempotency: an event id is processed at most once (processed_at set on success).
CREATE TABLE stripe_events (
  event_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  processed_at INTEGER,
  last_error TEXT
);

-- Sandbox usage segments reported by the control plane. usage_id is the caller's idempotency
-- key. weighted_seconds = wall seconds x machine size weight. overage_seconds is the part of
-- this segment past the period's included allowance, fixed when the row is inserted.
CREATE TABLE usage_events (
  usage_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  machine_size TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  weighted_seconds INTEGER NOT NULL,
  period_start INTEGER,
  overage_seconds INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX usage_events_period ON usage_events(account_id, period_start);

-- Outbox for Stripe meter events (overage only). Sent inline, retried by the cron trigger.
-- usage_id doubles as the Stripe meter event identifier, so a retry is deduplicated by Stripe.
CREATE TABLE meter_reports (
  usage_id TEXT PRIMARY KEY REFERENCES usage_events(usage_id),
  stripe_customer_id TEXT NOT NULL,
  seconds INTEGER NOT NULL,
  event_timestamp INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX meter_reports_pending ON meter_reports(status, created_at);
