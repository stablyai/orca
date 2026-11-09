-- Custom model-provider hosts (from ANTHROPIC_BASE_URL / OPENAI_BASE_URL secrets) this session's
-- egress allowlist adds to the defaults (comma list). egress_secret_hosts entries are now
-- `SECRET@host` (bare hosts from older rows still read as the default provider key).
ALTER TABLE sandboxes ADD COLUMN egress_allow_hosts TEXT;
