-- Plans and entitlements (design: .context/cloud/reports/entitlements-design.md). Additive only.
-- The plan catalog (plans, plan_versions) is data applied from catalog/catalog.json by
-- scripts/catalog-apply.ts; prices are mirrored from Stripe Price objects (plan_prices); access is
-- the set of entitlement_grants a billing account holds. Times are epoch milliseconds.

CREATE TABLE plans (
  plan_id TEXT PRIMARY KEY,
  -- 'self_serve' | 'contact_sales' | 'trial' | 'free'
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  public INTEGER NOT NULL DEFAULT 1,
  -- The version new subscriptions and grants get.
  current_version INTEGER NOT NULL,
  -- JSON: kind-specific display fields (contactUrl, priceLabel) and Stripe lookup keys.
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL
);

-- Immutable once applied: a change is a new version (catalog-apply refuses to rewrite one).
CREATE TABLE plan_versions (
  plan_id TEXT NOT NULL REFERENCES plans(plan_id),
  version INTEGER NOT NULL,
  -- {"<entitlement key>": {"value": ..., "perSeat": bool}} (src/entitlement-keys.ts)
  entitlements_json TEXT NOT NULL,
  -- [{"id": "...", "params": {...}, "text": "..."}]
  features_json TEXT NOT NULL DEFAULT '[]',
  -- Plan behaviour: payment grace, seat true-down, warnings, spend-cap bounds, seat bounds.
  policy_json TEXT NOT NULL DEFAULT '{}',
  -- SHA-256 of the three JSON columns, so a re-apply of the same content is a no-op.
  content_hash TEXT NOT NULL,
  note TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (plan_id, version)
);

-- Mirror of Stripe Price objects. Stripe is the only price authority; every price ever seen is
-- kept so a subscription on an older (grandfathered) price still maps to its plan and version.
CREATE TABLE plan_prices (
  stripe_price_id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL,
  plan_version INTEGER,
  -- 'seat' | 'overage'
  role TEXT NOT NULL,
  interval TEXT,
  lookup_key TEXT,
  unit_amount INTEGER,
  unit_amount_decimal TEXT,
  currency TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  -- 1 = currently holds the plan's lookup key: what Checkout sells and the catalog shows.
  is_checkout_price INTEGER NOT NULL DEFAULT 0,
  stripe_product_id TEXT,
  synced_at INTEGER NOT NULL
);
CREATE INDEX plan_prices_plan ON plan_prices(plan_id, role, interval, is_checkout_price);

-- One row per (source, entitlement key). A subscription's grants are a projection of its Stripe
-- state (subscriptions row); a trial's of its trials row; manual/promo rows are written by ops.
CREATE TABLE entitlement_grants (
  grant_id TEXT PRIMARY KEY,
  subject_id TEXT NOT NULL,
  entitlement_key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  per_seat INTEGER NOT NULL DEFAULT 0,
  seat_quantity INTEGER,
  -- 'subscription' | 'trial' | 'free_policy' | 'manual' | 'promo'
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  plan_id TEXT,
  plan_version INTEGER,
  -- 'active' | 'held' | 'revoked'
  state TEXT NOT NULL,
  hold_reason TEXT,
  held_since INTEGER,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER,
  revoked_at INTEGER,
  revoked_reason TEXT,
  -- When the source was last read (Stripe API read time for subscriptions): older reads never win.
  source_synced_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (source_type, source_id, entitlement_key)
);
CREATE INDEX entitlement_grants_subject ON entitlement_grants(subject_id, state);

-- Append-only history of grant changes (who/what changed access, and why).
CREATE TABLE entitlement_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  -- 'grant' | 'adjust' | 'hold' | 'release' | 'revoke'
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX entitlement_audit_subject ON entitlement_audit(subject_id, at);

-- Shadow mode (ENTITLEMENTS_MODE=shadow): every disagreement between the legacy computation and
-- the grant resolver. Zero rows over a full e2e run is the bar for switching to 'on'.
CREATE TABLE entitlement_shadow_diffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  diff_json TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX entitlement_shadow_diffs_at ON entitlement_shadow_diffs(at);

-- Cursors for the reconciliation cron (e.g. 'events_cursor' = last replayed Stripe event time).
CREATE TABLE stripe_sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- The seat price the subscription is on: maps it to its plan version (grandfathering) and is
-- how a price change can never orphan an existing subscriber.
ALTER TABLE subscriptions ADD COLUMN seat_price_id TEXT;
