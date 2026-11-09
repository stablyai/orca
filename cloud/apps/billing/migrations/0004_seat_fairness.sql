-- Seat fairness: the latest org member count (seats may stay above it until renewal), and the
-- member who started each sandbox (usage attribution, per-member caps, abuse review).
ALTER TABLE subscriptions ADD COLUMN member_count INTEGER;
ALTER TABLE usage_events ADD COLUMN user_id TEXT;
CREATE INDEX usage_events_member ON usage_events(account_id, period_start, user_id);
