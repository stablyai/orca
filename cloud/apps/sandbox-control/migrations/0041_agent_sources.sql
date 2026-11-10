-- Per-person agent Source (agent-sources contract §2): "Your sign-in" or "API key", as a default
-- (scope 'default'), a per-workspace override (scope = sandbox id), or the one-time sign-in offer answer
-- (scope 'offer', source 'accepted'|'declined'). Rows for a sandbox go with it.
CREATE TABLE agent_sources (
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  agent TEXT NOT NULL CHECK (agent IN ('claude', 'codex')),
  source TEXT NOT NULL CHECK (source IN ('sign-in', 'key', 'accepted', 'declined')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, scope, agent)
);
CREATE INDEX agent_sources_scope ON agent_sources (scope);
