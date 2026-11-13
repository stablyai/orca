-- RS-2: a failed auth check (count_tokens) alone no longer revokes an Orca-account sign-in. It marks the
-- sign-in "needs check" (suspect_at); the credential stays usable at egress so the next real agent request
-- can confirm it: a later 401 revokes, a success clears it. Never tested against a real OAuth token, so the
-- probe is a signal, not a verdict (agent-credential-checks.ts).
ALTER TABLE agent_credentials ADD COLUMN suspect_at INTEGER;
