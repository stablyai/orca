-- Team pricing: overage is opt-in per account with an admin-set monthly spend cap, and annual
-- plans keep a monthly allowance window (usage_events.period_start is that window's start).

-- 1 once an admin opts in to overage; spend cap in cents (NULL = the plan default).
ALTER TABLE billing_accounts ADD COLUMN overage_opt_in INTEGER NOT NULL DEFAULT 0;
ALTER TABLE billing_accounts ADD COLUMN spend_cap_cents INTEGER;

-- 'month' | 'year' (the seat price's interval) and the metered overage item, once added.
ALTER TABLE subscriptions ADD COLUMN billing_interval TEXT NOT NULL DEFAULT 'month';
ALTER TABLE subscriptions ADD COLUMN overage_item_id TEXT;
