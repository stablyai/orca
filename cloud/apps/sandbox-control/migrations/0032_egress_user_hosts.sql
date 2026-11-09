-- Hosts the workspace's own agent tools need (remote MCP servers synced from the desktop), added to
-- the egress allowlist on every boot (comma list). Set by PUT /v1/sandboxes/:id/egress/hosts; unlike
-- egress_allow_hosts it is not recomputed from secrets.
ALTER TABLE sandboxes ADD COLUMN egress_user_hosts TEXT;
