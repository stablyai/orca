-- EP-9: Stripe's portal (API 2025-09-30.clover) cancels by setting `cancel_at` (a date), not
-- `cancel_at_period_end`. The mirror keeps that date; cancel_at_period_end stays the "cancelling"
-- flag (set for either form). Epoch milliseconds; NULL when not cancelling. Additive.
ALTER TABLE subscriptions ADD COLUMN cancel_at INTEGER;
