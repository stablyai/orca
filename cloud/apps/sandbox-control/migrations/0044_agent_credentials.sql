-- Account credentials for agents, Personal only (agent-sources contract D11): the Claude setup-token or the
-- Codex broker's tokens (JSON), envelope-encrypted like secrets (AAD: scope 'account', user id, agent). Values
-- never leave the Worker except swapped into a request at egress (D10). Flags S1 (Claude) / S2 (Codex).
CREATE TABLE agent_credentials (
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  agent TEXT NOT NULL CHECK (agent IN ('claude', 'codex')),
  kek_id TEXT NOT NULL,
  wrapped_dek TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  -- What the person sees ("ada@example.com"); never a token.
  label TEXT,
  expires_at INTEGER,
  -- active | revoked (expired/expiring are derived from expires_at)
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'revoked')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, agent)
);
