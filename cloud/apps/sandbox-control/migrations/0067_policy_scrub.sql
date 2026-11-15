-- A4 (egress firewall migration; probe 2: a session's last network policy survives a stop or timeout on
-- the persistent record and is re-applied on resume): a stopped sandbox's record gets the token-free policy.
-- policy_scrubbed_at: when it last did; policy_scrub_pending: a scrub after a stop failed (reconcile retries).
ALTER TABLE sandboxes ADD COLUMN policy_scrubbed_at INTEGER;
ALTER TABLE sandboxes ADD COLUMN policy_scrub_pending INTEGER;
