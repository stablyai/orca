-- Honest start timings for GET /v1/config. ready_at moves on every wake, so ready_at - created_at
-- counted create + sleep + wake for any sandbox woken within two minutes of creation (bench and smoke
-- cycles made the "create p95" 23 s). These are written once per operation by the control plane.
ALTER TABLE sandboxes ADD COLUMN create_ms INTEGER;
-- Most recent wake: from the resume claim until orcad is ready.
ALTER TABLE sandboxes ADD COLUMN wake_ms INTEGER;
