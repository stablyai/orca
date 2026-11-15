-- "Sign in inside this workspace" (agent-sources contract §2): a per-person default Source of
-- 'in-workspace' stores nothing and injects nothing for that agent, so its own login inside each
-- sandbox wins. SQLite can't widen a CHECK in place, so the table is rebuilt with every row kept.
CREATE TABLE agent_sources_next (
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  agent TEXT NOT NULL CHECK (agent IN ('claude', 'codex')),
  source TEXT NOT NULL CHECK (source IN ('sign-in', 'key', 'in-workspace', 'accepted', 'declined')),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, scope, agent)
);
INSERT INTO agent_sources_next (user_id, account_id, scope, agent, source, updated_at)
  SELECT user_id, account_id, scope, agent, source, updated_at FROM agent_sources;
DROP TABLE agent_sources;
ALTER TABLE agent_sources_next RENAME TO agent_sources;
CREATE INDEX agent_sources_scope ON agent_sources (scope);
