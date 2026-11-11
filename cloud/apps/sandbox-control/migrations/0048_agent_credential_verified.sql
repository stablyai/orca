-- Last time the control plane's own auth check passed for this credential (POST
-- /v1/agent-credentials/claude/verify, or the check behind a provider 401). Recent passes answer verify
-- without calling the provider again.
ALTER TABLE agent_credentials ADD COLUMN verified_at INTEGER;
