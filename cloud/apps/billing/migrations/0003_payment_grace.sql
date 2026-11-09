-- Payment failure grace: when billing first saw the subscription past_due/unpaid (epoch ms).
-- Cleared when it is paid again. New starts stop immediately; running sandboxes are suspended
-- once the plan's grace period has passed (entitlements.ts).
ALTER TABLE subscriptions ADD COLUMN past_due_since INTEGER;
