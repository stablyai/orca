-- EGRESS-COMPILE (egress firewall migration, workstream A): every live policy write goes through
-- applySandboxPolicy. policy_generation orders writes (an older compile never lands over a newer one);
-- policy_stale_at marks a widening write that failed (reconcile retries it); egress_swap_mode is the
-- per-sandbox override of EGRESS_SWAP_MODE (null: the environment's default); policy_config_hash is the
-- hash of the operator inputs the last applied policy was compiled from (a mismatch is re-applied).
ALTER TABLE sandboxes ADD COLUMN policy_generation INTEGER;
ALTER TABLE sandboxes ADD COLUMN policy_stale_at INTEGER;
ALTER TABLE sandboxes ADD COLUMN egress_swap_mode TEXT;
ALTER TABLE sandboxes ADD COLUMN policy_config_hash TEXT;
