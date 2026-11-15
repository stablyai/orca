-- ARCHIVE-HOOK: what the control plane last learned about the repo's orca.yaml `scripts.archive`
-- (src/archive-hook.ts), so an archive or delete of an asleep workspace knows whether to offer a
-- wake for it. NULL: never looked; 'none': no hook; 'pending': a hook that hasn't run since the last
-- wake; 'done': it ran and succeeded. Additive.
ALTER TABLE sandboxes ADD COLUMN archive_hook TEXT;
